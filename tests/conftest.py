"""Configuración común de las pruebas.

- Pruebas unitarias (tests/unit): no necesitan base de datos.
- Pruebas de integración (tests/integration): necesitan una base PostgreSQL + PostGIS con el schema
  aplicado, indicada en TEST_DATABASE_URL. Sin esa variable se omiten. Por seguridad, el nombre de la
  base debe contener "test": las pruebas vacían sus tablas.
"""
import os
from urllib.parse import urlparse

from cryptography.fernet import Fernet

# La configuración de la app se lee al importarla: las variables deben existir antes del primer import
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL")
os.environ["DATABASE_URL"] = TEST_DATABASE_URL or "postgresql://sin-base@127.0.0.1:1/sin_base"
os.environ.setdefault("SECRET_KEY", Fernet.generate_key().decode())
os.environ["COOKIE_SECURE"] = "false"

import pytest  # noqa: E402
from sqlalchemy import text  # noqa: E402

from helpers import Tenant  # noqa: E402

if TEST_DATABASE_URL and "test" not in urlparse(TEST_DATABASE_URL).path:
    raise RuntimeError("TEST_DATABASE_URL debe apuntar a una base cuyo nombre contenga 'test'")


def pytest_collection_modifyitems(config, items):
    if TEST_DATABASE_URL:
        return
    skip = pytest.mark.skip(reason="Sin TEST_DATABASE_URL: se omiten las pruebas de integración")
    for item in items:
        if "integration" in item.keywords:
            item.add_marker(skip)


# ---------------------------------------------------------------- fixtures de integración

CARACTERISTICAS = [
    ("zona_segura", "Zona segura", "#1f7a5c"),
    ("contorno_edificio", "Contorno de edificio", "#3b6e8f"),
]


@pytest.fixture
def db():
    from app.database import SessionLocal

    session = SessionLocal()
    # Cada prueba parte de una base vacía (TRUNCATE en cascada desde la organización)
    session.execute(text("TRUNCATE organizacion, caracteristica RESTART IDENTITY CASCADE"))
    for codigo, nombre, color in CARACTERISTICAS:
        session.execute(
            text("INSERT INTO caracteristica (codigo, nombre, color_hex) VALUES (:c, :n, :h)"),
            {"c": codigo, "n": nombre, "h": color},
        )
    session.commit()
    yield session
    session.close()


@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as c:
        yield c


@pytest.fixture
def org_a(db):
    return Tenant(db, "org-a")


@pytest.fixture
def org_b(db):
    return Tenant(db, "org-b")
