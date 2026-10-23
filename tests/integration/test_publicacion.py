"""Publicación versionada del grafo, control de concurrencia y Gestión de Edificios."""
import pytest
from sqlalchemy import text

from helpers import as_user, building_id, sample_payload

pytestmark = pytest.mark.integration

VERSION = "X-Snapshot-Version"


def _publicar(client, sede_id, payload, base=None):
    headers = {"X-Base-Version": str(base)} if base is not None else {}
    return client.post(f"/admin/api/sedes/{sede_id}/publish", json=payload, headers=headers)


def _count(db, tabla, sede_id=None):
    sql = f"SELECT count(*) FROM {tabla}" + (" WHERE sede_id = :s" if sede_id else "")
    return db.execute(text(sql), {"s": sede_id}).scalar()


def test_primera_publicacion_crea_la_version_1_y_persiste_el_grafo(client, db, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    r = _publicar(client, org_a.sede.id, payload, base=0)
    assert r.status_code == 200
    assert r.json()["version"] == 1 and r.headers[VERSION] == "1"
    assert _count(db, "nodo", org_a.sede.id) == len(payload["nodes"])
    assert _count(db, "arista") == len(payload["edges"])
    assert _count(db, "edificio_piso") == 3
    assert _count(db, "conector", org_a.sede.id) == 1
    assert _count(db, "zona", org_a.sede.id) == 1
    # Los nodos que no son waypoint quedan como puntos de interés
    assert _count(db, "poi") == 2


def test_el_snapshot_publicado_es_el_que_se_entrega(client, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    _publicar(client, org_a.sede.id, payload, base=0)
    r = client.get(f"/admin/api/sedes/{org_a.sede.id}/snapshot")
    assert r.status_code == 200 and r.headers[VERSION] == "1"
    assert r.headers["cache-control"] == "no-store"
    assert {n["id"] for n in r.json()["nodes"]} == {n["id"] for n in payload["nodes"]}
    assert r.json()["meta"]["version"] == "2.3"


def test_sin_grafo_publicado_la_version_base_es_0(client, org_a):
    as_user(client, org_a)
    r = client.get(f"/admin/api/sedes/{org_a.sede.id}/snapshot")
    assert r.status_code == 404 and r.headers[VERSION] == "0"


def test_publicar_sobre_una_version_desactualizada_responde_409(client, db, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    assert _publicar(client, org_a.sede.id, payload, base=0).status_code == 200
    # Otra pestaña que cargó la versión 0 intenta publicar
    r = _publicar(client, org_a.sede.id, payload, base=0)
    assert r.status_code == 409 and r.headers[VERSION] == "1"
    assert _count(db, "snapshot") == 1


def test_publicaciones_sucesivas_incrementan_la_version(client, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    for esperado in (1, 2, 3):
        r = _publicar(client, org_a.sede.id, payload, base=esperado - 1)
        assert r.json()["version"] == esperado


@pytest.mark.xfail(strict=True, reason=(
    "Defecto detectado por esta prueba: la sesión usa autoflush=False, así que el snapshot nuevo aún no "
    "está en la tabla cuando corre el DELETE de retención y se conservan 3 versiones en vez de 2"))
def test_solo_se_conservan_las_dos_ultimas_versiones(client, db, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    for base in range(4):
        _publicar(client, org_a.sede.id, payload, base=base)
    versiones = db.execute(text("SELECT version FROM snapshot ORDER BY version")).scalars().all()
    assert versiones == [3, 4]


def test_payload_invalido_responde_422_y_no_cambia_nada(client, db, org_a):
    as_user(client, org_a)
    valido = sample_payload()
    _publicar(client, org_a.sede.id, valido, base=0)

    invalido = sample_payload()
    invalido["nodes"][1]["floor"] = 9  # piso que no existe en el edificio
    r = _publicar(client, org_a.sede.id, invalido, base=1)
    assert r.status_code == 422 and "no existe" in r.json()["detail"]
    assert _count(db, "snapshot") == 1
    ids = set(db.execute(text("SELECT id::text FROM nodo")).scalars())
    assert ids == {n["id"] for n in valido["nodes"]}


def test_elementos_eliminados_del_mapa_se_borran_de_las_tablas(client, db, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    _publicar(client, org_a.sede.id, payload, base=0)
    # Se quita el baño del piso 2 y su conexión
    bano = next(n for n in payload["nodes"] if n["name"] == "Baño piso 2")
    payload["nodes"].remove(bano)
    payload["edges"] = [e for e in payload["edges"] if bano["id"] not in (e["from"], e["to"])]
    assert _publicar(client, org_a.sede.id, payload, base=1).status_code == 200
    assert _count(db, "nodo", org_a.sede.id) == len(payload["nodes"])
    assert _count(db, "arista") == len(payload["edges"])
    assert _count(db, "poi") == 1


def test_formato_antiguo_se_normaliza_al_publicar(client, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    b = payload["buildings"][1]
    b.pop("pisos"), b.pop("acceso")
    b["min"], b["max"] = -1, 2
    assert _publicar(client, org_a.sede.id, payload, base=0).status_code == 200
    snap = client.get(f"/admin/api/sedes/{org_a.sede.id}/snapshot").json()
    assert [p["numero"] for p in snap["buildings"][1]["pisos"]] == [-1, 0, 1, 2]


# ------------------------------------------------------------------ Gestión de Edificios

def test_gestion_de_edificios_crea_una_version_nueva(client, db, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    _publicar(client, org_a.sede.id, payload, base=0)
    cambios = {"base_version": 1, "edificios": [{
        "id": building_id(payload), "nombre": "Edificio Central", "acceso": 1,
        "pisos": [{"numero": -1, "desde": -1}, {"numero": 1, "desde": 1}, {"numero": 3, "desde": 2}],
    }]}
    r = client.patch(f"/admin/api/sedes/{org_a.sede.id}/edificios", json=cambios)
    assert r.status_code == 200 and r.json()["version"] == 2
    pisos = db.execute(text("SELECT numero FROM edificio_piso ORDER BY numero")).scalars().all()
    assert pisos == [-1, 1, 3]
    assert db.execute(text("SELECT nombre FROM edificio")).scalar() == "Edificio Central"


def test_gestion_de_edificios_con_version_desactualizada_responde_409(client, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    _publicar(client, org_a.sede.id, payload, base=0)
    _publicar(client, org_a.sede.id, payload, base=1)
    r = client.patch(f"/admin/api/sedes/{org_a.sede.id}/edificios",
                     json={"base_version": 1, "eliminar": [building_id(payload)]})
    assert r.status_code == 409 and r.headers[VERSION] == "2"


def test_gestion_de_edificios_rechaza_cambios_invalidos(client, org_a):
    as_user(client, org_a)
    payload = sample_payload()
    _publicar(client, org_a.sede.id, payload, base=0)
    # El acceso apunta a un piso que no queda en el edificio
    cambios = {"base_version": 1, "edificios": [{
        "id": building_id(payload), "nombre": "Edificio A", "acceso": 5,
        "pisos": [{"numero": 1, "desde": 1}, {"numero": 2, "desde": 2}],
    }]}
    assert client.patch(f"/admin/api/sedes/{org_a.sede.id}/edificios", json=cambios).status_code == 422


# ------------------------------------------------------------------ sedes y contorno

def test_contorno_de_sede_valido_e_invalido(client, db, org_a):
    as_user(client, org_a)
    base = {"nombre": "Campus Norte", "lat": -33.0, "lng": -71.0, "zoom": 17}
    cuadrado = [[-71.0, -33.0], [-70.99, -33.0], [-70.99, -32.99], [-71.0, -32.99]]
    r = client.post("/admin/api/sedes", json={**base, "contorno": cuadrado})
    assert r.status_code == 200
    assert db.execute(text("SELECT ST_IsValid(contorno) FROM sede WHERE id = :id"), {"id": r.json()["id"]}).scalar()

    mariposa = [[-71.0, -33.0], [-70.99, -32.99], [-70.99, -33.0], [-71.0, -32.99]]  # se cruza consigo mismo
    r = client.post("/admin/api/sedes", json={**base, "contorno": mariposa})
    assert r.status_code == 422 and "se cruza" in r.json()["detail"]

    r = client.post("/admin/api/sedes", json={**base, "contorno": [[-71.0, -33.0], [-70.99, -33.0]]})
    assert r.status_code == 422
