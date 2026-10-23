"""Buscador de lugares: caché y manejo de errores del servicio externo (Photon simulado, sin red)."""
import urllib.error
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.geocode import router as geocode
from app.main import app
from app.security import get_current_user


@pytest.fixture
def client(monkeypatch):
    geocode._cache.clear()
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(organizacion_id="org")
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    geocode._cache.clear()


def test_resultados_se_guardan_en_cache(client, monkeypatch):
    llamadas = []

    def falso_photon(q, solo_recintos, lat, lng):
        llamadas.append(q)
        return [{"nombre": "Campus", "detalle": "Valparaíso", "lat": -33.03, "lng": -71.59}]

    monkeypatch.setattr(geocode, "_buscar_photon", falso_photon)
    r1 = client.get("/admin/api/geocode", params={"q": "Campus"})
    r2 = client.get("/admin/api/geocode", params={"q": "campus "})  # misma búsqueda normalizada
    assert r1.status_code == r2.status_code == 200
    assert r1.json() == r2.json()
    assert len(llamadas) == 1


def test_servicio_caido_responde_502(client, monkeypatch):
    def caido(*args):
        raise urllib.error.URLError("sin conexión")

    monkeypatch.setattr(geocode, "_buscar_photon", caido)
    r = client.get("/admin/api/geocode", params={"q": "Campus"})
    assert r.status_code == 502


def test_consulta_demasiado_corta_responde_422(client):
    assert client.get("/admin/api/geocode", params={"q": "a"}).status_code == 422


def test_sin_sesion_responde_401_en_json():
    app.dependency_overrides.clear()
    with TestClient(app) as c:
        r = c.get("/admin/api/geocode", params={"q": "Campus"})
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/json")
