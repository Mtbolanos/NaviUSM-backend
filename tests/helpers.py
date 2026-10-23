"""Utilidades compartidas por las pruebas: organizaciones de prueba y mapas de ejemplo."""
import uuid


class Tenant:
    """Organización de prueba con un administrador y una sede."""

    PASSWORD = "clave-de-prueba-123"

    def __init__(self, db, slug: str):
        from app.models import Organizacion, Sede, Usuario
        from app.security import get_hash_password

        self.org = Organizacion(nombre=f"Universidad {slug}", slug=slug)
        db.add(self.org)
        db.flush()
        self.user = Usuario(
            organizacion_id=self.org.id,
            email=f"admin@{slug}.cl",
            password_hash=get_hash_password(self.PASSWORD),
            rol="admin",
        )
        self.sede = Sede(organizacion_id=self.org.id, nombre=f"Sede {slug}", latitud=-33.03, longitud=-71.59)
        db.add_all([self.user, self.sede])
        db.commit()

    def cookie(self) -> str:
        from app.security import fernet

        return fernet.encrypt(str(self.user.id).encode()).decode()


def as_user(client, tenant):
    """Deja el cliente con la sesión del administrador de la organización."""
    client.cookies.set("session", tenant.cookie())
    return client


# ---------------------------------------------------------------- datos de grafo

def new_id() -> str:
    return str(uuid.uuid4())


def sample_payload() -> dict:
    """Mapa mínimo válido (formato 2.3): un edificio de tres pisos con una escalera y una entrada."""
    bld = new_id()
    conector = new_id()
    entrada, p1, p2, s1, s2 = (new_id() for _ in range(5))
    return {
        "meta": {"version": "2.3"},
        "buildings": [
            {"id": "exterior", "name": "Exterior"},
            {"id": bld, "name": "Edificio A", "acceso": 1,
             "pisos": [{"numero": -1, "nombre": None}, {"numero": 1, "nombre": None}, {"numero": 2, "nombre": "Mezzanine"}]},
        ],
        "conectores": [{"id": conector, "tipo": "escalera", "nombre": "Escalera norte", "building": bld}],
        "nodes": [
            {"id": entrada, "type": "entrance", "name": "Entrada A", "lat": -33.0301, "lng": -71.5901, "floor": 1, "building": "exterior"},
            {"id": p1, "type": "waypoint", "name": "Pasillo 1", "lat": -33.0302, "lng": -71.5902, "floor": 1, "building": bld},
            {"id": p2, "type": "baño", "name": "Baño piso 2", "lat": -33.0303, "lng": -71.5903, "floor": 2, "building": bld},
            {"id": s1, "type": "waypoint", "name": "Escalera P1", "lat": -33.0304, "lng": -71.5904, "floor": 1, "building": bld, "conector_id": conector},
            {"id": s2, "type": "waypoint", "name": "Escalera P2", "lat": -33.0304, "lng": -71.5904, "floor": 2, "building": bld, "conector_id": conector},
        ],
        "edges": [
            {"id": new_id(), "from": entrada, "to": p1, "weight": 10.0, "es_escalera": False},
            {"id": new_id(), "from": p1, "to": s1, "weight": 5.0, "es_escalera": False},
            {"id": new_id(), "from": s1, "to": s2, "weight": 19.0, "es_escalera": True},
            {"id": new_id(), "from": s2, "to": p2, "weight": 6.0, "es_escalera": False},
        ],
        "zonas": [
            {"id": new_id(), "building": bld, "name": "Edificio A", "tags": ["contorno_edificio"], "color": "#3b6e8f",
             "geojson": {"type": "Polygon", "coordinates": [[[-71.591, -33.031], [-71.589, -33.031], [-71.589, -33.029], [-71.591, -33.031]]]}},
        ],
    }


def building_id(payload: dict) -> str:
    return next(b["id"] for b in payload["buildings"] if b["id"] != "exterior")
