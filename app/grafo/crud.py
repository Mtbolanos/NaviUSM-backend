from sqlalchemy import desc, text
from sqlalchemy.orm import Session

from app.models import Sede, Snapshot
from app.zonas.crud import upsert_zonas


def get_latest_snapshot(db: Session, sede_id: str):
    return (
        db.query(Snapshot)
        .filter(Snapshot.sede_id == sede_id)
        .order_by(desc(Snapshot.version))
        .first()
    )


def create_snapshot(db: Session, sede_id, org_id, payload: dict, version: int) -> Snapshot:
    snapshot = Snapshot(
        sede_id=sede_id,
        organizacion_id=org_id,
        payload=payload,
        version=version,
    )
    db.add(snapshot)
    return snapshot


def publish_graph_data(db: Session, sede: Sede, payload: dict, org_id) -> int:
    # 1. Snapshot para consumo offline del móvil
    last_snap = get_latest_snapshot(db, sede.id)
    new_version = (last_snap.version + 1) if last_snap else 1
    create_snapshot(db, sede.id, org_id, payload, new_version)

    # 2. UPSERT de Edificios
    incoming_blds = []
    for b in payload.get("buildings", []):
        if b["id"] == "exterior":
            continue
        incoming_blds.append(b["id"])
        db.execute(
            text("""
                INSERT INTO edificio (id, sede_id, organizacion_id, nombre, piso_min, piso_max)
                VALUES (:id, :sede, :org, :nombre, :p_min, :p_max)
                ON CONFLICT (id) DO UPDATE SET
                    nombre = EXCLUDED.nombre,
                    piso_min = EXCLUDED.piso_min,
                    piso_max = EXCLUDED.piso_max
            """),
            {"id": b["id"], "sede": sede.id, "org": org_id, "nombre": b["name"], "p_min": b["min"], "p_max": b["max"]},
        )

    # 3. UPSERT de Nodos y POIs
    incoming_nodes = []
    for n in payload.get("nodes", []):
        incoming_nodes.append(n["id"])
        edificio_uuid = n.get("building") if n.get("building") != "exterior" else None

        db.execute(
            text("""
                INSERT INTO nodo (id, sede_id, organizacion_id, geom, piso, tipo, edificio_id)
                VALUES (:id, :sede, :org, ST_SetSRID(ST_MakePoint(:lng, :lat, :piso), 4326), :piso, :tipo, :edificio_id)
                ON CONFLICT (id) DO UPDATE SET
                    geom = EXCLUDED.geom,
                    piso = EXCLUDED.piso,
                    tipo = EXCLUDED.tipo,
                    edificio_id = EXCLUDED.edificio_id
            """),
            {
                "id": n["id"], "sede": sede.id, "org": org_id,
                "lng": n["lng"], "lat": n["lat"], "piso": n.get("floor", 1),
                "tipo": n["type"], "edificio_id": edificio_uuid,
            },
        )

        if n["type"] not in ["waypoint", "user"]:
            db.execute(
                text("""
                    INSERT INTO poi (nodo_id, organizacion_id, nombre, categoria, horario, descripcion, link_derivacion)
                    VALUES (:nodo, :org, :nombre, :cat, :horario, :descripcion, :link)
                    ON CONFLICT (nodo_id) DO UPDATE SET
                        nombre = EXCLUDED.nombre,
                        categoria = EXCLUDED.categoria,
                        horario = EXCLUDED.horario,
                        descripcion = EXCLUDED.descripcion,
                        link_derivacion = EXCLUDED.link_derivacion
                """),
                {
                    "nodo": n["id"], "org": org_id, "nombre": n["name"], "cat": n["type"],
                    "horario": n.get("horario"),
                    "descripcion": n.get("descripcion"), "link": n.get("link_derivacion"),
                },
            )
        else:
            db.execute(text("DELETE FROM poi WHERE nodo_id = :nodo"), {"nodo": n["id"]})

    # 4. UPSERT de Aristas
    incoming_edges = []
    for e in payload.get("edges", []):
        incoming_edges.append(e["id"])
        db.execute(
            text("""
                INSERT INTO arista (id, origen_id, destino_id, organizacion_id, distancia, es_escalera)
                VALUES (:id, :origen, :destino, :org, :distancia, :es_escalera)
                ON CONFLICT (id) DO UPDATE SET
                    distancia = EXCLUDED.distancia,
                    es_escalera = EXCLUDED.es_escalera
            """),
            {
                "id": e["id"], 
                "origen": e["from"], 
                "destino": e["to"], 
                "org": org_id, 
                "distancia": e["weight"],
                "es_escalera": e.get("es_escalera", False)
            },
        )

    # 5. Preparar source/target para pgRouting
    db.execute(
        text("""
            UPDATE arista a
            SET source = n1.gid, target = n2.gid
            FROM nodo n1, nodo n2
            WHERE a.origen_id = n1.id AND a.destino_id = n2.id
              AND a.organizacion_id = :org
        """),
        {"org": org_id},
    )

    # 6. Limpieza de huérfanos
    if incoming_edges:
        db.execute(
            text("""
                DELETE FROM arista WHERE organizacion_id = :org AND id IN (
                    SELECT a.id FROM arista a JOIN nodo n ON a.origen_id = n.id WHERE n.sede_id = :sede
                ) AND id != ALL(CAST(:in_edges AS uuid[]))
            """),
            {"org": org_id, "sede": sede.id, "in_edges": incoming_edges},
        )
    else:
        db.execute(
            text("DELETE FROM arista WHERE id IN (SELECT a.id FROM arista a JOIN nodo n ON a.origen_id = n.id WHERE n.sede_id = :sede)"),
            {"sede": sede.id},
        )

    if incoming_nodes:
        db.execute(
            text("DELETE FROM nodo WHERE sede_id = :sede AND id != ALL(CAST(:in_nodes AS uuid[]))"),
            {"sede": sede.id, "in_nodes": incoming_nodes},
        )
    else:
        db.execute(text("DELETE FROM nodo WHERE sede_id = :sede"), {"sede": sede.id})

    if incoming_blds:
        db.execute(
            text("DELETE FROM edificio WHERE sede_id = :sede AND id != ALL(CAST(:in_blds AS uuid[]))"),
            {"sede": sede.id, "in_blds": incoming_blds},
        )
    else:
        db.execute(text("DELETE FROM edificio WHERE sede_id = :sede"), {"sede": sede.id})

    # 7. UPSERT de Zonas (contornos de edificio, zonas seguras/silenciosas/accesibles)
    upsert_zonas(db, sede, payload.get("zonas", []), org_id)

    db.commit()
    return new_version
