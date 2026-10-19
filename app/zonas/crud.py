import json

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models import Caracteristica


def get_caracteristicas(db: Session):
    return db.query(Caracteristica).order_by(Caracteristica.nombre).all()


def upsert_zonas(db: Session, sede, payload_zonas: list, org_id) -> None:
    """Escribe las zonas y sus etiquetas con una sentencia por tabla (las filas viajan como JSON)."""
    by_id = {}
    for z in payload_zonas:
        by_id[z["id"]] = z  # una fila por id (la última gana)
    zonas = list(by_id.values())
    incoming_zonas = [z["id"] for z in zonas]

    if zonas:
        db.execute(
            text("""
                INSERT INTO zona (id, sede_id, organizacion_id, edificio_id, nombre, geom, color_hex)
                SELECT r.id, :sede, :org, r.edificio_id, r.nombre,
                       ST_SetSRID(ST_GeomFromGeoJSON(r.geojson::text), 4326), r.color_hex
                FROM jsonb_to_recordset(CAST(:rows AS jsonb))
                    AS r(id uuid, edificio_id uuid, nombre text, geojson jsonb, color_hex text)
                ON CONFLICT (id) DO UPDATE SET
                    edificio_id = EXCLUDED.edificio_id,
                    nombre = EXCLUDED.nombre,
                    geom = EXCLUDED.geom,
                    color_hex = EXCLUDED.color_hex
                WHERE zona.organizacion_id = EXCLUDED.organizacion_id
                AND zona.sede_id = EXCLUDED.sede_id
            """),
            {
                "sede": sede.id, "org": org_id,
                "rows": json.dumps([{
                    "id": z["id"],
                    "edificio_id": z.get("building") if z.get("building") not in (None, "exterior") else None,
                    "nombre": z.get("name"), "geojson": z["geojson"], "color_hex": z.get("color"),
                } for z in zonas]),
            },
        )
        db.execute(text("DELETE FROM zona_caracteristica WHERE zona_id = ANY(CAST(:ids AS uuid[]))"), {"ids": incoming_zonas})
        db.execute(
            text("""
                INSERT INTO zona_caracteristica (zona_id, caracteristica_id)
                SELECT DISTINCT r.id, c.id
                FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(id uuid, tags jsonb)
                CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(r.tags, '[]'::jsonb)) AS t(codigo)
                JOIN caracteristica c ON c.codigo = t.codigo
            """),
            {"rows": json.dumps([{"id": z["id"], "tags": z.get("tags") or []} for z in zonas])},
        )
        db.execute(
            text("DELETE FROM zona WHERE sede_id = :sede AND id != ALL(CAST(:in_zonas AS uuid[]))"),
            {"sede": sede.id, "in_zonas": incoming_zonas},
        )
    else:
        db.execute(text("DELETE FROM zona WHERE sede_id = :sede"), {"sede": sede.id})
