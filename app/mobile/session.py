from datetime import datetime, timedelta, timezone

import jwt
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.config import settings

AUDIENCE = "naviusm-mobile"
ALGORITHM = "HS256"

# Clave de firma derivada de SECRET_KEY con HKDF: no requiere una variable de entorno nueva
# y queda separada criptográficamente de la clave que cifra las cookies del panel.
_SIGNING_KEY = HKDF(
    algorithm=hashes.SHA256(), length=32, salt=None, info=b"naviusm-mobile-session-v1",
).derive(settings.secret_key.encode("utf-8"))


def issue_session_token(api_key_id, org_id) -> tuple[str, int]:
    now = datetime.now(timezone.utc)
    ttl = settings.mobile_session_ttl
    claims = {
        "sub": str(api_key_id),
        "org": str(org_id),
        "aud": AUDIENCE,
        "iat": now,
        "exp": now + timedelta(seconds=ttl),
    }
    return jwt.encode(claims, _SIGNING_KEY, algorithm=ALGORITHM), ttl


def decode_session_token(token: str) -> dict:
    # Lanza jwt.InvalidTokenError si la firma, la audiencia o la expiración no son válidas
    return jwt.decode(
        token, _SIGNING_KEY, algorithms=[ALGORITHM], audience=AUDIENCE,
        options={"require": ["exp", "iat", "sub", "org", "aud"]},
    )