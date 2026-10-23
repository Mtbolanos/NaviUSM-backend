"""Aislamiento multi-tenant: un administrador nunca ve ni modifica datos de otra organización."""
import pytest
from sqlalchemy import text

from app.models import Sede
from helpers import as_user, building_id, sample_payload

pytestmark = pytest.mark.integration


def _publicar(client, sede_id, payload, base=None):
    headers = {"X-Base-Version": str(base)} if base is not None else {}
    return client.post(f"/admin/api/sedes/{sede_id}/publish", json=payload, headers=headers)


def test_no_puede_leer_el_mapa_de_otra_organizacion(client, org_a, org_b):
    as_user(client, org_b)
    assert _publicar(client, org_b.sede.id, sample_payload()).status_code == 200
    as_user(client, org_a)
    # 404 y no 403: no se revela que la sede existe
    assert client.get(f"/admin/api/sedes/{org_b.sede.id}/snapshot").status_code == 404


def test_no_puede_publicar_en_la_sede_de_otra_organizacion(client, db, org_a, org_b):
    as_user(client, org_a)
    assert _publicar(client, org_b.sede.id, sample_payload()).status_code == 404
    assert db.execute(text("SELECT count(*) FROM snapshot")).scalar() == 0


def test_no_puede_modificar_ni_borrar_sedes_ajenas(client, db, org_a, org_b):
    as_user(client, org_a)
    datos = {"nombre": "Robada", "lat": -33.0, "lng": -71.0, "zoom": 17}
    assert client.put(f"/admin/api/sedes/{org_b.sede.id}", json=datos).status_code == 404
    assert client.delete(f"/admin/api/sedes/{org_b.sede.id}").status_code == 404
    db.expire_all()
    assert db.get(Sede, org_b.sede.id).nombre == "Sede org-b"


def test_no_puede_reutilizar_ids_de_otra_organizacion(client, db, org_a, org_b):
    payload_b = sample_payload()
    as_user(client, org_b)
    assert _publicar(client, org_b.sede.id, payload_b).status_code == 200

    # A intenta publicar en su propia sede un nodo con el id de un nodo de B (para sobrescribirlo)
    payload_a = sample_payload()
    payload_a["nodes"][1]["id"] = payload_b["nodes"][1]["id"]
    payload_a["edges"][0]["to"] = payload_a["nodes"][1]["id"]
    payload_a["edges"][1]["from"] = payload_a["nodes"][1]["id"]
    as_user(client, org_a)
    r = _publicar(client, org_a.sede.id, payload_a)
    assert r.status_code == 409
    # El nodo de B quedó intacto
    org = db.execute(text("SELECT organizacion_id FROM nodo WHERE id = :id"), {"id": payload_b["nodes"][1]["id"]}).scalar()
    assert str(org) == str(org_b.org.id)


def test_no_puede_reutilizar_ids_de_otra_sede_de_la_misma_organizacion(client, db, org_a):
    otra = Sede(organizacion_id=org_a.org.id, nombre="Otra sede", latitud=-33.4, longitud=-70.6)
    db.add(otra)
    db.commit()
    as_user(client, org_a)
    payload = sample_payload()
    assert _publicar(client, org_a.sede.id, payload).status_code == 200
    assert _publicar(client, otra.id, payload).status_code == 409


def test_aristas_solo_entre_nodos_del_mismo_mapa(client, org_a):
    payload = sample_payload()
    payload["edges"][0]["to"] = "00000000-0000-0000-0000-000000000099"
    as_user(client, org_a)
    assert _publicar(client, org_a.sede.id, payload).status_code == 409


def test_gestion_de_edificios_de_otra_organizacion(client, org_a, org_b):
    payload = sample_payload()
    as_user(client, org_b)
    assert _publicar(client, org_b.sede.id, payload).status_code == 200
    as_user(client, org_a)
    cambios = {"base_version": 1, "eliminar": [building_id(payload)]}
    assert client.patch(f"/admin/api/sedes/{org_b.sede.id}/edificios", json=cambios).status_code == 404


def test_api_keys_aisladas_por_organizacion(client, org_a, org_b):
    as_user(client, org_b)
    key_b = client.post("/admin/api/api-keys", json={"nombre": "App B"}).json()
    as_user(client, org_a)
    assert client.get("/admin/api/api-keys").json() == []
    assert client.delete(f"/admin/api/api-keys/{key_b['id']}").status_code == 404
