import json

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Caracteristica


def get_caracteristicas(db: Session):
    return db.query(Caracteristica).order_by(Caracteristica.nombre).all()


def upsert_zonas(db: Session, sede, payload_zonas: list, org_id) -> None:
    incoming_zonas = []
    for z in payload_zonas:
        incoming_zonas.append(z["id"])
        edificio_uuid = z.get("building") if z.get("building") not in (None, "exterior") else None

        db.execute(
            text("""
                INSERT INTO zona (id, sede_id, organizacion_id, edificio_id, nombre, geom, color_hex)
                VALUES (:id, :sede, :org, :edificio_id, :nombre, ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326), :color_hex)
                ON CONFLICT (id) DO UPDATE SET
                    edificio_id = EXCLUDED.edificio_id,
                    nombre = EXCLUDED.nombre,
                    geom = EXCLUDED.geom,
                    color_hex = EXCLUDED.color_hex
            """),
            {
                "id": z["id"], "sede": sede.id, "org": org_id,
                "edificio_id": edificio_uuid,
                "nombre": z.get("name"), "geojson": json.dumps(z["geojson"]),
                "color_hex": z.get("color"),
            },
        )

        db.execute(text("DELETE FROM zona_caracteristica WHERE zona_id = :id"), {"id": z["id"]})
        tags = z.get("tags", [])
        if tags:
            db.execute(
                text("""
                    INSERT INTO zona_caracteristica (zona_id, caracteristica_id)
                    SELECT :zona_id, id FROM caracteristica WHERE codigo = ANY(:codigos)
                """),
                {"zona_id": z["id"], "codigos": tags},
            )

    if incoming_zonas:
        db.execute(
            text("DELETE FROM zona WHERE sede_id = :sede AND id != ALL(CAST(:in_zonas AS uuid[]))"),
            {"sede": sede.id, "in_zonas": incoming_zonas},
        )
    else:
        db.execute(text("DELETE FROM zona WHERE sede_id = :sede"), {"sede": sede.id})
