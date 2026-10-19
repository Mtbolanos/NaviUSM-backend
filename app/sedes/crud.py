import json
import math

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Sede

CONTORNO_MAX_VERTICES = 500


class ContornoInvalido(ValueError):
    pass


def get_sedes_by_org(db: Session, org_id):
    return db.query(Sede).filter(Sede.organizacion_id == org_id).all()


def contornos_by_org(db: Session, org_id) -> dict[str, list]:
    """Contorno de cada sede de la organización: {sede_id: [[lng, lat], ...]} (anillo exterior, cerrado)."""
    rows = db.execute(
        text("SELECT id, ST_AsGeoJSON(contorno) FROM sede WHERE organizacion_id = :org AND contorno IS NOT NULL"),
        {"org": org_id},
    ).all()
    return {str(r[0]): json.loads(r[1])["coordinates"][0] for r in rows}


def sedes_data(db: Session, org_id) -> list[dict]:
    """Sedes para las páginas del panel (y su configuración JSON)."""
    contornos = contornos_by_org(db, org_id)
    return [
        {
            "id": str(s.id), "nombre": s.nombre, "lat": float(s.latitud), "lng": float(s.longitud),
            "zoom": s.zoom_defecto, "contorno": contornos.get(str(s.id)),
        }
        for s in get_sedes_by_org(db, org_id)
    ]


def normalizar_contorno(db: Session, ring) -> str | None:
    """Valida un anillo [[lng, lat], ...] y devuelve el GeoJSON del polígono (o None si no hay contorno).

    Un solo anillo (sin huecos), entre 3 y CONTORNO_MAX_VERTICES vértices, coordenadas válidas y sin
    autointersecciones (ST_IsValid). Se cierra si viene abierto.
    """
    if ring is None:
        return None
    if not isinstance(ring, list):
        raise ContornoInvalido("El contorno debe ser una lista de puntos [lng, lat]")
    pts = []
    for p in ring:
        if not (isinstance(p, (list, tuple)) and len(p) >= 2):
            raise ContornoInvalido("Cada punto del contorno debe ser [lng, lat]")
        try:
            lng, lat = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            raise ContornoInvalido("Coordenadas del contorno inválidas") from None
        if not (math.isfinite(lng) and math.isfinite(lat) and -180 <= lng <= 180 and -90 <= lat <= 90):
            raise ContornoInvalido("Coordenadas del contorno fuera de rango")
        pts.append([lng, lat])
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        raise ContornoInvalido("El contorno necesita al menos 3 vértices")
    if len(pts) > CONTORNO_MAX_VERTICES:
        raise ContornoInvalido(f"El contorno no puede tener más de {CONTORNO_MAX_VERTICES} vértices")
    geojson = json.dumps({"type": "Polygon", "coordinates": [pts + [pts[0]]]})
    reason = db.execute(
        text("SELECT CASE WHEN ST_IsValid(g) THEN NULL ELSE ST_IsValidReason(g) END "
             "FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) AS g) t"),
        {"g": geojson},
    ).scalar()
    if reason:
        raise ContornoInvalido("El contorno se cruza consigo mismo: corrige sus vértices")
    return geojson


def _set_contorno(db: Session, sede_id, geojson: str | None) -> None:
    db.execute(
        text("UPDATE sede SET contorno = CASE WHEN CAST(:g AS text) IS NULL THEN NULL "
             "ELSE ST_SetSRID(ST_GeomFromGeoJSON(:g), 4326) END WHERE id = :id"),
        {"g": geojson, "id": sede_id},
    )


def create_sede(db: Session, org_id, nombre: str, lat: float, lng: float, zoom: int = 18, contorno=None) -> Sede:
    geojson = normalizar_contorno(db, contorno)
    sede = Sede(organizacion_id=org_id, nombre=nombre, latitud=lat, longitud=lng, zoom_defecto=zoom)
    db.add(sede)
    db.flush()
    if geojson:
        _set_contorno(db, sede.id, geojson)
    db.commit()
    db.refresh(sede)
    return sede


def update_sede(db: Session, sede_id, org_id, nombre: str, lat: float, lng: float, zoom: int, contorno) -> bool:
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == org_id).first()
    if not sede:
        return False
    geojson = normalizar_contorno(db, contorno)
    sede.nombre = nombre
    sede.latitud = lat
    sede.longitud = lng
    sede.zoom_defecto = zoom
    _set_contorno(db, sede.id, geojson)
    db.commit()
    return True


def delete_sede(db: Session, sede_id: str, org_id) -> bool:
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == org_id).first()
    if not sede:
        return False
    db.delete(sede)
    db.commit()
    return True
