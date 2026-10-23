"""Contraseñas, cookie de sesión del panel, token de la app móvil y API keys (sin base de datos)."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import bcrypt
import jwt
import pytest
from fastapi import Response

from app.api_keys.crud import KEY_PREFIX, get_active_key_by_raw, hash_key, is_active
from app.config import settings
from app.mobile.session import ALGORITHM, AUDIENCE, _SIGNING_KEY, decode_session_token, issue_session_token
from app.security import BCRYPT_MAX_BYTES, fernet, get_hash_password, password_too_long, set_auth_cookie, verify_password


# ------------------------------------------------------------------ contraseñas

class TestContrasenas:
    def test_hash_y_verificacion(self):
        h = get_hash_password("clave-segura-123")
        assert h.startswith("$2")  # formato bcrypt
        assert verify_password("clave-segura-123", h)
        assert not verify_password("otra-clave", h)

    def test_cada_hash_usa_una_sal_distinta(self):
        assert get_hash_password("misma") != get_hash_password("misma")

    def test_el_largo_se_mide_en_bytes_utf8(self):
        assert not password_too_long("a" * BCRYPT_MAX_BYTES)
        assert password_too_long("a" * (BCRYPT_MAX_BYTES + 1))
        assert password_too_long("ñ" * 37)  # 37 caracteres, 74 bytes

    def test_no_se_guarda_una_contrasena_de_mas_de_72_bytes(self):
        with pytest.raises(ValueError, match="72 bytes"):
            get_hash_password("a" * 73)

    def test_verificar_una_contrasena_larga_no_lanza_error(self):
        # Antes del arreglo, bcrypt 5 lanzaba ValueError y el login respondía 500
        h = get_hash_password("clave-segura-123")
        assert verify_password("x" * 200, h) is False

    def test_compatible_con_hashes_creados_truncando_a_72_bytes(self):
        # bcrypt < 5 truncaba en silencio: esos hashes deben seguir funcionando con la contraseña completa
        larga = "z" * 90
        h_antiguo = bcrypt.hashpw(larga.encode()[:72], bcrypt.gensalt()).decode()
        assert verify_password(larga, h_antiguo)


# ------------------------------------------------------------------ cookie del panel

class TestCookieDeSesion:
    def _cookie_header(self) -> str:
        response = Response()
        set_auth_cookie(response, "00000000-0000-0000-0000-000000000001")
        return response.headers["set-cookie"]

    def test_atributos_de_seguridad(self):
        header = self._cookie_header().lower()
        assert "httponly" in header
        assert "samesite=lax" in header
        assert f"max-age={settings.session_max_age}" in header
        assert "path=/" in header

    def test_el_contenido_va_cifrado(self):
        header = self._cookie_header()
        valor = header.split(";")[0].split("=", 1)[1]
        assert "00000000-0000-0000-0000-000000000001" not in valor
        assert fernet.decrypt(valor.encode()).decode() == "00000000-0000-0000-0000-000000000001"


# ------------------------------------------------------------------ token de la app móvil

class TestTokenMovil:
    def test_emision_y_validacion(self):
        token, ttl = issue_session_token("key-1", "org-1")
        claims = decode_session_token(token)
        assert claims["sub"] == "key-1" and claims["org"] == "org-1" and claims["aud"] == AUDIENCE
        assert ttl == settings.mobile_session_ttl
        assert claims["exp"] - claims["iat"] == ttl

    def test_token_expirado(self):
        now = datetime.now(timezone.utc)
        token = jwt.encode({"sub": "k", "org": "o", "aud": AUDIENCE, "iat": now - timedelta(hours=2),
                            "exp": now - timedelta(hours=1)}, _SIGNING_KEY, algorithm=ALGORITHM)
        with pytest.raises(jwt.ExpiredSignatureError):
            decode_session_token(token)

    def test_firma_alterada(self):
        token, _ = issue_session_token("key-1", "org-1")
        alterado = token[:-2] + ("AA" if not token.endswith("AA") else "BB")
        with pytest.raises(jwt.InvalidTokenError):
            decode_session_token(alterado)

    def test_audiencia_incorrecta(self):
        now = datetime.now(timezone.utc)
        token = jwt.encode({"sub": "k", "org": "o", "aud": "otra-app", "iat": now,
                            "exp": now + timedelta(minutes=5)}, _SIGNING_KEY, algorithm=ALGORITHM)
        with pytest.raises(jwt.InvalidAudienceError):
            decode_session_token(token)

    def test_falta_un_claim_obligatorio(self):
        now = datetime.now(timezone.utc)
        token = jwt.encode({"sub": "k", "aud": AUDIENCE, "iat": now, "exp": now + timedelta(minutes=5)},
                           _SIGNING_KEY, algorithm=ALGORITHM)
        with pytest.raises(jwt.MissingRequiredClaimError):
            decode_session_token(token)

    def test_firmado_con_la_secret_key_directa_no_sirve(self):
        # La clave de firma se deriva con HKDF: no es la misma que cifra las cookies del panel
        now = datetime.now(timezone.utc)
        token = jwt.encode({"sub": "k", "org": "o", "aud": AUDIENCE, "iat": now, "exp": now + timedelta(minutes=5)},
                           settings.secret_key, algorithm=ALGORITHM)
        with pytest.raises(jwt.InvalidSignatureError):
            decode_session_token(token)

    def test_rechaza_el_algoritmo_none(self):
        now = datetime.now(timezone.utc)
        token = jwt.encode({"sub": "k", "org": "o", "aud": AUDIENCE, "iat": now, "exp": now + timedelta(minutes=5)},
                           None, algorithm="none")
        with pytest.raises(jwt.InvalidTokenError):
            decode_session_token(token)


# ------------------------------------------------------------------ API keys

class TestApiKeys:
    def test_hash_sha256_determinista(self):
        assert hash_key("nvu_abc") == hash_key("nvu_abc")
        assert len(hash_key("nvu_abc")) == 64

    @pytest.mark.parametrize("revoked, expires_delta, esperado", [
        (None, None, True),                       # sin expiración
        (None, timedelta(days=1), True),          # expira en el futuro
        (None, timedelta(days=-1), False),        # ya expiró
        (datetime.now(timezone.utc), None, False),  # revocada
    ])
    def test_vigencia(self, revoked, expires_delta, esperado):
        expires = datetime.now(timezone.utc) + expires_delta if expires_delta else None
        assert is_active(SimpleNamespace(revoked_at=revoked, expires_at=expires)) is esperado

    @pytest.mark.parametrize("raw", ["", "sin-prefijo", "abc_" + "x" * 40])
    def test_key_sin_prefijo_se_rechaza_sin_consultar_la_base(self, raw):
        assert not raw.startswith(KEY_PREFIX)
        assert get_active_key_by_raw(db=None, raw_key=raw) is None
