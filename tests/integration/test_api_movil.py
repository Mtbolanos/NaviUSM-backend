"""API móvil: API key por organización → token de sesión → organización y snapshot."""
from datetime import datetime, timedelta, timezone

import pytest

from app.models import ApiKey
from helpers import as_user, sample_payload

pytestmark = pytest.mark.integration

BASE = "/api/v1/mobile"


def _crear_key(client, tenant, **extra):
    as_user(client, tenant)
    r = client.post("/admin/api/api-keys", json={"nombre": "App", **extra})
    assert r.status_code == 201
    client.cookies.clear()  # la app no tiene sesión del panel
    return r.json()


def _token(client, raw_key):
    r = client.post(f"{BASE}/session", headers={"X-API-Key": raw_key})
    assert r.status_code == 200
    return r.json()["access_token"]


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def test_la_key_se_entrega_una_sola_vez_y_no_se_guarda_en_claro(client, db, org_a):
    creada = _crear_key(client, org_a)
    assert creada["key"].startswith("nvu_") and creada["prefijo"] == creada["key"][:12]
    fila = db.get(ApiKey, creada["id"])
    assert fila.key_hash != creada["key"] and len(fila.key_hash) == 64
    as_user(client, org_a)
    assert "key" not in client.get("/admin/api/api-keys").json()[0]


@pytest.mark.parametrize("headers", [{}, {"X-API-Key": "nvu_inventada"}, {"X-API-Key": "sin-prefijo"}])
def test_sesion_sin_key_valida_responde_401(client, db, headers):
    assert client.post(f"{BASE}/session", headers=headers).status_code == 401


def test_flujo_completo(client, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    client.post(f"/admin/api/sedes/{org_a.sede.id}/publish", json=payload)
    key = _crear_key(client, org_a)

    r = client.post(f"{BASE}/session", headers={"X-API-Key": key["key"]})
    assert r.status_code == 200
    sesion = r.json()
    assert sesion["token_type"] == "bearer" and sesion["expires_in"] > 0

    org = client.get(f"{BASE}/organizacion", headers=_bearer(sesion["access_token"])).json()
    assert org["slug"] == "org-a" and [s["uuid"] for s in org["sedes"]] == [str(org_a.sede.id)]

    snap = client.get(f"{BASE}/sedes/{org_a.sede.id}/snapshot", headers=_bearer(sesion["access_token"]))
    assert snap.status_code == 200
    assert {n["id"] for n in snap.json()["nodes"]} == {n["id"] for n in payload["nodes"]}


def test_endpoints_sin_token_o_con_token_invalido_responden_401(client, org_a):
    assert client.get(f"{BASE}/organizacion").status_code == 401
    r = client.get(f"{BASE}/organizacion", headers=_bearer("no.es.un.token"))
    assert r.status_code == 401 and r.headers["www-authenticate"] == "Bearer"


def test_no_entrega_sedes_ni_snapshots_de_otra_organizacion(client, org_a, org_b):
    as_user(client, org_b)
    client.post(f"/admin/api/sedes/{org_b.sede.id}/publish", json=sample_payload())
    token = _token(client, _crear_key(client, org_a)["key"])
    org = client.get(f"{BASE}/organizacion", headers=_bearer(token)).json()
    assert str(org_b.sede.id) not in {s["uuid"] for s in org["sedes"]}
    assert client.get(f"{BASE}/sedes/{org_b.sede.id}/snapshot", headers=_bearer(token)).status_code == 404


def test_revocar_la_key_corta_el_acceso_de_inmediato(client, org_a):
    key = _crear_key(client, org_a)
    token = _token(client, key["key"])
    assert client.get(f"{BASE}/organizacion", headers=_bearer(token)).status_code == 200

    as_user(client, org_a)
    assert client.delete(f"/admin/api/api-keys/{key['id']}").status_code == 200
    client.cookies.clear()
    # El token aún no expira, pero la key se revisa en cada petición
    assert client.get(f"{BASE}/organizacion", headers=_bearer(token)).status_code == 401
    assert client.post(f"{BASE}/session", headers={"X-API-Key": key["key"]}).status_code == 401


def test_key_expirada_no_entrega_sesion(client, db, org_a):
    key = _crear_key(client, org_a)
    db.query(ApiKey).filter(ApiKey.id == key["id"]).update(
        {"expires_at": datetime.now(timezone.utc) - timedelta(minutes=1)})
    db.commit()
    assert client.post(f"{BASE}/session", headers={"X-API-Key": key["key"]}).status_code == 401


def test_no_se_puede_crear_una_key_con_expiracion_pasada(client, org_a):
    as_user(client, org_a)
    pasada = (datetime.now(timezone.utc) - timedelta(days=1)).isoformat()
    assert client.post("/admin/api/api-keys", json={"nombre": "App", "expires_at": pasada}).status_code == 422
