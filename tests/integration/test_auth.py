"""Login, sesión del panel y cambio de contraseña contra la base de prueba."""
import pytest

from app.models import Usuario
from app.security import verify_password
from helpers import Tenant, as_user

pytestmark = pytest.mark.integration


def test_login_correcto_crea_la_cookie_y_redirige(client, org_a):
    r = client.post("/login", data={"email": "admin@org-a.cl", "password": Tenant.PASSWORD}, follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].endswith("/admin")
    cookie = r.headers["set-cookie"].lower()
    assert cookie.startswith("session=") and "httponly" in cookie and "samesite=lax" in cookie


def test_login_con_clave_incorrecta_no_crea_sesion(client, org_a):
    r = client.post("/login", data={"email": "admin@org-a.cl", "password": "incorrecta"}, follow_redirects=False)
    assert r.status_code == 200
    assert "Credenciales inválidas" in r.text
    assert "set-cookie" not in r.headers


def test_login_con_clave_de_mas_de_72_bytes_no_produce_error_500(client, org_a):
    r = client.post("/login", data={"email": "admin@org-a.cl", "password": "x" * 200}, follow_redirects=False)
    assert r.status_code == 200
    assert "Credenciales inválidas" in r.text


def test_pagina_sin_sesion_redirige_al_login(client, db):
    r = client.get("/admin", follow_redirects=False)
    assert r.status_code == 303 and r.headers["location"].endswith("/login")


def test_api_sin_sesion_responde_401_en_json(client, db):
    r = client.get("/admin/api/api-keys")
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/json")


def test_cookie_alterada_es_rechazada(client, org_a):
    client.cookies.set("session", org_a.cookie()[:-4] + "AAAA")
    assert client.get("/admin/api/api-keys").status_code == 401


def test_usuario_desactivado_pierde_el_acceso(client, db, org_a):
    as_user(client, org_a)
    assert client.get("/admin/api/api-keys").status_code == 200
    db.query(Usuario).filter(Usuario.id == org_a.user.id).update({"is_active": False})
    db.commit()
    assert client.get("/admin/api/api-keys").status_code == 401


def test_cambio_de_contrasena(client, db, org_a):
    as_user(client, org_a)
    r = client.post("/cambiar-contrasena", data={"old_password": Tenant.PASSWORD, "new_password": "nueva-clave-456"})
    assert r.status_code == 200 and "actualizada" in r.text
    db.expire_all()
    assert verify_password("nueva-clave-456", db.get(Usuario, org_a.user.id).password_hash)


def test_cambio_de_contrasena_rechaza_la_actual_incorrecta(client, db, org_a):
    as_user(client, org_a)
    r = client.post("/cambiar-contrasena", data={"old_password": "otra", "new_password": "nueva-clave-456"})
    assert "incorrecta" in r.text
    db.expire_all()
    assert verify_password(Tenant.PASSWORD, db.get(Usuario, org_a.user.id).password_hash)


def test_cambio_de_contrasena_de_mas_de_72_bytes_muestra_error_y_no_la_guarda(client, db, org_a):
    # Regresión: con bcrypt 5 esto respondía 500
    as_user(client, org_a)
    r = client.post("/cambiar-contrasena", data={"old_password": Tenant.PASSWORD, "new_password": "ñ" * 40})
    assert r.status_code == 200
    assert "no puede superar" in r.text
    db.expire_all()
    assert verify_password(Tenant.PASSWORD, db.get(Usuario, org_a.user.id).password_hash)


def test_logout_borra_la_cookie(client, org_a):
    as_user(client, org_a)
    r = client.get("/logout", follow_redirects=False)
    assert r.status_code == 303
    assert 'session=""' in r.headers["set-cookie"] or "max-age=0" in r.headers["set-cookie"].lower()
