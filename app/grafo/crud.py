import copy
import json
from uuid import UUID
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


class PayloadOwnershipError(ValueError):
    """El payload referencia elementos de otra organización o sede, o tiene IDs inválidos."""


class PayloadValidationError(ValueError):
    """El payload tiene datos inconsistentes (por ejemplo, pisos repetidos o nodos en pisos inexistentes)."""


class VersionConflictError(Exception):
    """Se publicó otra versión después de la que el cliente cargó: publicar ahora pisaría esos cambios."""

    def __init__(self, current: int):
        super().__init__(f"El mapa cambió: la versión publicada es la {current}")
        self.current = current


SNAPSHOT_FORMAT = "2.3"
TIPOS_CONECTOR = ("escalera", "ascensor", "rampa")
PISO_NOMBRE_MAX = 100
PESO_POR_PISO = 15  # mismo valor que usa el editor: distancia + 15 por piso de diferencia


def _as_int(value, what: str) -> int:
    # bool es subclase de int en Python: se rechaza explícitamente
    if isinstance(value, bool) or not isinstance(value, int):
        raise PayloadValidationError(f"{what} debe ser un número entero")
    return value


def normalize_buildings(payload: dict) -> None:
    """Deja cada edificio en el formato 2.2: {id, name, acceso, pisos: [{numero, nombre}]}.

    Acepta el formato anterior (min/max) y lo convierte, para snapshots antiguos y clientes con caché.
    """
    for b in payload.get("buildings", []):
        if b.get("id") == "exterior":
            continue
        if not isinstance(b.get("pisos"), list):
            lo = _as_int(b.get("min", 1), "El piso mínimo")
            hi = _as_int(b.get("max", lo), "El piso máximo")
            b["pisos"] = [{"numero": n, "nombre": None} for n in range(min(lo, hi), max(lo, hi) + 1)]
        pisos = []
        for p in b["pisos"]:
            if not isinstance(p, dict):
                raise PayloadValidationError(f"Piso inválido en el edificio {b.get('name')!r}")
            nombre = p.get("nombre")
            nombre = nombre.strip() if isinstance(nombre, str) and nombre.strip() else None
            pisos.append({"numero": _as_int(p.get("numero"), "El número de piso"), "nombre": nombre})
        b["pisos"] = sorted(pisos, key=lambda p: p["numero"])
        if "acceso" not in b or b["acceso"] is None:
            numeros = [p["numero"] for p in pisos]
            b["acceso"] = 1 if 1 in numeros else (min(numeros) if numeros else 1)
        b.pop("min", None)
        b.pop("max", None)
    payload.setdefault("conectores", [])
    payload.setdefault("meta", {})["version"] = SNAPSHOT_FORMAT


def validate_buildings(payload: dict) -> None:
    """Pisos únicos y con nombre acotado, acceso existente y nodos solo en pisos que existen."""
    floors_by_building = {}
    for b in payload.get("buildings", []):
        if b.get("id") == "exterior":
            continue
        name = b.get("name") or "sin nombre"
        numeros = [p["numero"] for p in b["pisos"]]
        if not numeros:
            raise PayloadValidationError(f"El edificio {name!r} debe tener al menos un piso")
        if len(set(numeros)) != len(numeros):
            raise PayloadValidationError(f"El edificio {name!r} tiene números de piso repetidos")
        if any(p["nombre"] and len(p["nombre"]) > PISO_NOMBRE_MAX for p in b["pisos"]):
            raise PayloadValidationError(f"Un nombre de piso del edificio {name!r} supera los {PISO_NOMBRE_MAX} caracteres")
        if _as_int(b["acceso"], "El piso de acceso") not in numeros:
            raise PayloadValidationError(f"El piso de acceso del edificio {name!r} no está entre sus pisos")
        floors_by_building[str(b["id"])] = (name, set(numeros))

    for n in payload.get("nodes", []):
        bld = n.get("building")
        if bld in (None, "exterior") or str(bld) not in floors_by_building:
            continue
        name, numeros = floors_by_building[str(bld)]
        if _as_int(n.get("floor", 1), "El piso de un nodo") not in numeros:
            raise PayloadValidationError(
                f"El nodo {n.get('name')!r} está en el piso {n.get('floor')}, que no existe en el edificio {name!r}"
            )

    # Conectores: tipo válido, edificio existente y paradas dentro de ese mismo edificio
    conectores = {}
    for c in payload.get("conectores", []):
        if c.get("tipo") not in TIPOS_CONECTOR:
            raise PayloadValidationError(f"Tipo de conector inválido: {c.get('tipo')!r}")
        if str(c.get("building")) not in floors_by_building:
            raise PayloadValidationError(f"El conector {c.get('nombre')!r} no pertenece a un edificio del mapa")
        if c.get("nombre") is not None and (not isinstance(c["nombre"], str) or len(c["nombre"]) > 255):
            raise PayloadValidationError("Nombre de conector inválido")
        conectores[str(c.get("id"))] = c
    for n in payload.get("nodes", []):
        cid = n.get("conector_id")
        if cid is None:
            continue
        c = conectores.get(str(cid))
        if c is None:
            raise PayloadValidationError(f"El nodo {n.get('name')!r} es parada de un conector que no existe")
        if str(n.get("building")) != str(c.get("building")):
            raise PayloadValidationError(f"El nodo {n.get('name')!r} es parada de un conector de otro edificio")


def floor_difference(a: dict, b: dict, acceso: dict) -> int:
    """Pisos de diferencia para el peso de una arista. El exterior y el piso de acceso de un edificio
    están al mismo nivel (la calle): una entrada no suma costo de piso aunque el acceso no sea el 1."""
    ba, bb = a.get("building") or "exterior", b.get("building") or "exterior"
    fa, fb = a.get("floor", 1), b.get("floor", 1)
    if ba == "exterior" and bb != "exterior" and fb == acceso.get(str(bb)):
        return 0
    if bb == "exterior" and ba != "exterior" and fa == acceso.get(str(ba)):
        return 0
    return abs(fa - fb)


def apply_building_changes(payload: dict, cambios: list[dict], eliminar: list[str]) -> dict:
    """Aplica los cambios de Gestión de Edificios sobre una copia del snapshot y la devuelve.

    cambios: [{id, nombre, acceso, pisos: [{numero, nombre, desde}]}], donde "desde" es el número que
    tenía el piso antes (None si es nuevo). Un piso antiguo que no aparece como "desde" se elimina
    junto con sus nodos y las conexiones de esos nodos. Al renumerar, los nodos se mueven con su piso.
    """
    data = copy.deepcopy(payload)
    normalize_buildings(data)
    data.setdefault("nodes", [])
    data.setdefault("edges", [])
    data.setdefault("zonas", [])
    buildings = {str(b["id"]): b for b in data.get("buildings", []) if b.get("id") != "exterior"}
    # Estado previo (piso y edificio de cada nodo, acceso de cada edificio) para ajustar los pesos al final
    before_nodes = {n["id"]: {"floor": n.get("floor", 1), "building": n.get("building")} for n in data["nodes"]}
    before_acceso = {bid: b["acceso"] for bid, b in buildings.items()}

    def drop_nodes(ids: set) -> None:
        data["nodes"] = [n for n in data["nodes"] if n["id"] not in ids]
        data["edges"] = [e for e in data["edges"] if e["from"] not in ids and e["to"] not in ids]

    for bid in map(str, eliminar):
        if bid not in buildings:
            raise PayloadValidationError("Uno de los edificios a eliminar no existe en el mapa publicado")
        drop_nodes({n["id"] for n in data["nodes"] if n["id"] == bid or n.get("building") == bid})
        zonas = []
        for z in data["zonas"]:
            if z.get("building") == bid:
                if "contorno_edificio" in (z.get("tags") or []):
                    continue
                z["building"] = None  # las zonas seguras del edificio se conservan, ahora en el exterior
            zonas.append(z)
        data["zonas"] = zonas
        data["conectores"] = [c for c in data.get("conectores", []) if str(c.get("building")) != bid]
        data["buildings"] = [b for b in data["buildings"] if str(b.get("id")) != bid]
        del buildings[bid]

    for c in cambios:
        bid = str(c["id"])
        b = buildings.get(bid)
        if b is None:
            raise PayloadValidationError("Uno de los edificios modificados no existe en el mapa publicado")
        nombre = (c.get("nombre") or "").strip()
        if not nombre:
            raise PayloadValidationError("El nombre del edificio no puede quedar vacío")

        old_numbers = {p["numero"] for p in b["pisos"]}
        desdes = [p["desde"] for p in c["pisos"] if p.get("desde") is not None]
        if len(set(desdes)) != len(desdes) or not set(desdes) <= old_numbers:
            raise PayloadValidationError(f"Los cambios de pisos del edificio {nombre!r} no corresponden a sus pisos actuales")
        mapping = {p["desde"]: p["numero"] for p in c["pisos"] if p.get("desde") is not None}
        removed = old_numbers - set(mapping)

        drop_nodes({n["id"] for n in data["nodes"] if n.get("building") == bid and n.get("floor") in removed})

        for n in data["nodes"]:
            if n.get("building") == bid and n.get("floor") in mapping:
                n["floor"] = mapping[n["floor"]]

        b["name"] = nombre
        b["acceso"] = c["acceso"]
        b["pisos"] = sorted(({"numero": p["numero"], "nombre": p.get("nombre")} for p in c["pisos"]), key=lambda p: p["numero"])
        for n in data["nodes"]:
            if n["id"] == bid:
                n["name"] = nombre
        for z in data["zonas"]:
            if z.get("building") == bid and "contorno_edificio" in (z.get("tags") or []):
                z["name"] = nombre

    # Conectores que quedaron sin paradas (sus pisos se eliminaron)
    used = {str(n.get("conector_id")) for n in data["nodes"] if n.get("conector_id")}
    data["conectores"] = [c for c in data.get("conectores", []) if str(c.get("id")) in used]

    # Pesos: se ajusta la parte de pisos de las aristas cuyo desnivel cambió (renumeración o acceso)
    after_acceso = {bid: b["acceso"] for bid, b in buildings.items()}
    now = {n["id"]: n for n in data["nodes"]}
    for e in data["edges"]:
        a, b = now.get(e["from"]), now.get(e["to"])
        if a is None or b is None:
            continue
        before = floor_difference(before_nodes.get(a["id"], a), before_nodes.get(b["id"], b), before_acceso)
        after = floor_difference(a, b, after_acceso)
        if after != before:
            e["weight"] = e.get("weight", 0) + (after - before) * PESO_POR_PISO

    normalize_buildings(data)
    validate_buildings(data)
    return data


def _parse_ids(items, key="id", skip=()):
    ids = []
    for item in items:
        value = item.get(key)
        if value in skip:
            continue
        try:
            ids.append(str(UUID(str(value))))
        except (ValueError, TypeError):
            raise PayloadOwnershipError(f"ID inválido en el payload: {value!r}")
    return ids


def validate_payload_ownership(db: Session, sede: Sede, payload: dict, org_id) -> None:
    """Impide que un publish modifique filas de otra organización o de otra sede reutilizando sus IDs."""
    bld_ids = _parse_ids(payload.get("buildings", []), skip=("exterior",))
    node_ids = _parse_ids(payload.get("nodes", []))
    edge_ids = _parse_ids(payload.get("edges", []))
    zona_ids = _parse_ids(payload.get("zonas", []))
    conector_ids = _parse_ids(payload.get("conectores", []))

    checks = [
        ("edificio", bld_ids, "organizacion_id <> :org OR sede_id <> :sede"),
        ("nodo", node_ids, "organizacion_id <> :org OR sede_id <> :sede"),
        ("zona", zona_ids, "organizacion_id <> :org OR sede_id <> :sede"),
        ("conector", conector_ids, "organizacion_id <> :org OR sede_id <> :sede"),
        ("arista", edge_ids, "organizacion_id <> :org"),
    ]
    for table, ids, condition in checks:
        if not ids:
            continue
        conflict = db.execute(
            text(f"SELECT 1 FROM {table} WHERE id = ANY(CAST(:ids AS uuid[])) AND ({condition}) LIMIT 1"),
            {"ids": ids, "org": org_id, "sede": sede.id},
        ).first()
        if conflict:
            raise PayloadOwnershipError(f"El payload contiene elementos ({table}) que pertenecen a otra sede u organización")

    # Las aristas solo pueden unir nodos incluidos en este mismo payload
    node_set = set(node_ids)
    edges = payload.get("edges", [])
    if set(_parse_ids(edges, "from")) - node_set or set(_parse_ids(edges, "to")) - node_set:
        raise PayloadOwnershipError("Hay aristas que conectan nodos que no pertenecen a esta sede")

def _unique_by_id(items) -> list:
    """Una fila por id (la última gana), como cuando se insertaba fila por fila con ON CONFLICT."""
    by_id = {}
    for item in items:
        by_id[item["id"]] = item
    return list(by_id.values())


def _execute_rows(db: Session, sql: str, rows: list, **params) -> None:
    """Ejecuta un INSERT ... SELECT FROM jsonb_to_recordset(:rows) con todas las filas en un solo viaje."""
    if rows:
        db.execute(text(sql), {"rows": json.dumps(rows), **params})


def publish_graph_data(db: Session, sede: Sede, payload: dict, org_id, base_version: int | None = None) -> int:
    """Publica el grafo. Con base_version, rechaza la publicación si desde entonces se publicó otra versión."""
    normalize_buildings(payload)
    validate_buildings(payload)
    validate_payload_ownership(db, sede, payload, org_id)

    # Bloquea la sede hasta el commit: dos publicaciones simultáneas no pueden leer la misma versión
    db.execute(text("SELECT 1 FROM sede WHERE id = :sede FOR UPDATE"), {"sede": sede.id})
    # 1. Snapshot para consumo offline del móvil
    last_snap = get_latest_snapshot(db, sede.id)
    current_version = last_snap.version if last_snap else 0
    if base_version is not None and base_version != current_version:
        raise VersionConflictError(current_version)
    new_version = current_version + 1
    create_snapshot(db, sede.id, org_id, payload, new_version)

    # 2-4. Edificios, pisos, nodos, POIs y aristas: una sentencia por tabla (las filas viajan como JSON).
    # Antes era una sentencia por fila (miles por publicación), y cada una es un viaje de red a la base.
    buildings = _unique_by_id(b for b in payload.get("buildings", []) if b["id"] != "exterior")
    nodes = _unique_by_id(payload.get("nodes", []))
    edges = _unique_by_id(payload.get("edges", []))
    incoming_blds = [b["id"] for b in buildings]
    incoming_nodes = [n["id"] for n in nodes]
    incoming_edges = [e["id"] for e in edges]

    if buildings:
        _execute_rows(db, """
            INSERT INTO edificio (id, sede_id, organizacion_id, nombre, piso_acceso)
            SELECT r.id, :sede, :org, r.nombre, r.acceso
            FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(id uuid, nombre text, acceso int)
            ON CONFLICT (id) DO UPDATE SET
                nombre = EXCLUDED.nombre,
                piso_acceso = EXCLUDED.piso_acceso
            WHERE edificio.organizacion_id = EXCLUDED.organizacion_id
            AND edificio.sede_id = EXCLUDED.sede_id
        """, [{"id": b["id"], "nombre": b["name"], "acceso": b["acceso"]} for b in buildings], sede=sede.id, org=org_id)
        # Los pisos se reemplazan completos: el snapshot es la fuente de verdad
        db.execute(text("DELETE FROM edificio_piso WHERE edificio_id = ANY(CAST(:ids AS uuid[]))"), {"ids": incoming_blds})
        _execute_rows(db, """
            INSERT INTO edificio_piso (edificio_id, organizacion_id, numero, nombre)
            SELECT r.edificio_id, :org, r.numero, r.nombre
            FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(edificio_id uuid, numero int, nombre text)
        """, [{"edificio_id": b["id"], "numero": p["numero"], "nombre": p["nombre"]} for b in buildings for p in b["pisos"]], org=org_id)

    conectores = _unique_by_id(payload.get("conectores", []))
    if conectores:
        _execute_rows(db, """
            INSERT INTO conector (id, sede_id, edificio_id, organizacion_id, tipo, nombre)
            SELECT r.id, :sede, r.edificio_id, :org, r.tipo, r.nombre
            FROM jsonb_to_recordset(CAST(:rows AS jsonb)) AS r(id uuid, edificio_id uuid, tipo text, nombre text)
            ON CONFLICT (id) DO UPDATE SET
                edificio_id = EXCLUDED.edificio_id,
                tipo = EXCLUDED.tipo,
                nombre = EXCLUDED.nombre
            WHERE conector.organizacion_id = EXCLUDED.organizacion_id
            AND conector.sede_id = EXCLUDED.sede_id
        """, [{"id": c["id"], "edificio_id": c["building"], "tipo": c["tipo"], "nombre": c.get("nombre")} for c in conectores],
            sede=sede.id, org=org_id)

    if nodes:
        _execute_rows(db, """
            INSERT INTO nodo (id, sede_id, organizacion_id, geom, piso, tipo, edificio_id, conector_id)
            SELECT r.id, :sede, :org, ST_SetSRID(ST_MakePoint(r.lng, r.lat, r.piso), 4326), r.piso, r.tipo, r.edificio_id, r.conector_id
            FROM jsonb_to_recordset(CAST(:rows AS jsonb))
                AS r(id uuid, lng float8, lat float8, piso int, tipo text, edificio_id uuid, conector_id uuid)
            ON CONFLICT (id) DO UPDATE SET
                geom = EXCLUDED.geom,
                piso = EXCLUDED.piso,
                tipo = EXCLUDED.tipo,
                edificio_id = EXCLUDED.edificio_id,
                conector_id = EXCLUDED.conector_id
            WHERE nodo.organizacion_id = EXCLUDED.organizacion_id
            AND nodo.sede_id = EXCLUDED.sede_id
        """, [{
            "id": n["id"], "lng": n["lng"], "lat": n["lat"], "piso": n.get("floor", 1), "tipo": n["type"],
            "edificio_id": n.get("building") if n.get("building") not in (None, "exterior") else None,
            "conector_id": n.get("conector_id"),
        } for n in nodes], sede=sede.id, org=org_id)

        pois = [n for n in nodes if n["type"] not in ("waypoint", "user")]
        not_pois = [n["id"] for n in nodes if n["type"] in ("waypoint", "user")]
        if pois:
            _execute_rows(db, """
                INSERT INTO poi (nodo_id, organizacion_id, nombre, categoria, horario, descripcion, link_derivacion)
                SELECT r.nodo_id, :org, r.nombre, r.categoria, r.horario, r.descripcion, r.link
                FROM jsonb_to_recordset(CAST(:rows AS jsonb))
                    AS r(nodo_id uuid, nombre text, categoria text, horario text, descripcion text, link text)
                ON CONFLICT (nodo_id) DO UPDATE SET
                    nombre = EXCLUDED.nombre,
                    categoria = EXCLUDED.categoria,
                    horario = EXCLUDED.horario,
                    descripcion = EXCLUDED.descripcion,
                    link_derivacion = EXCLUDED.link_derivacion
                WHERE poi.organizacion_id = EXCLUDED.organizacion_id
            """, [{
                "nodo_id": n["id"], "nombre": n["name"], "categoria": n["type"], "horario": n.get("horario"),
                "descripcion": n.get("descripcion"), "link": n.get("link_derivacion"),
            } for n in pois], org=org_id)
        if not_pois:
            db.execute(text("DELETE FROM poi WHERE nodo_id = ANY(CAST(:ids AS uuid[]))"), {"ids": not_pois})

    if edges:
        _execute_rows(db, """
            INSERT INTO arista (id, origen_id, destino_id, organizacion_id, distancia, es_escalera)
            SELECT r.id, r.origen, r.destino, :org, r.distancia, r.es_escalera
            FROM jsonb_to_recordset(CAST(:rows AS jsonb))
                AS r(id uuid, origen uuid, destino uuid, distancia numeric, es_escalera boolean)
            ON CONFLICT (id) DO UPDATE SET
                distancia = EXCLUDED.distancia,
                es_escalera = EXCLUDED.es_escalera
            WHERE arista.organizacion_id = EXCLUDED.organizacion_id
        """, [{
            "id": e["id"], "origen": e["from"], "destino": e["to"], "distancia": e["weight"],
            "es_escalera": bool(e.get("es_escalera", False)),
        } for e in edges], org=org_id)

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

    db.execute(
        text("DELETE FROM conector WHERE sede_id = :sede AND id != ALL(CAST(:ids AS uuid[]))"),
        {"sede": sede.id, "ids": [c["id"] for c in conectores]},
    )

    if incoming_blds:
        db.execute(
            text("DELETE FROM edificio WHERE sede_id = :sede AND id != ALL(CAST(:in_blds AS uuid[]))"),
            {"sede": sede.id, "in_blds": incoming_blds},
        )
    else:
        db.execute(text("DELETE FROM edificio WHERE sede_id = :sede"), {"sede": sede.id})

    # 7. UPSERT de Zonas (contornos de edificio, zonas seguras/silenciosas/accesibles)
    upsert_zonas(db, sede, payload.get("zonas", []), org_id)

    # 8. Limpiar Snapshots antiguos (Mantener solo las 2 versiones más recientes)
    db.execute(
        text("""
            DELETE FROM snapshot 
            WHERE id IN (
                SELECT id FROM (
                    SELECT id, row_number() OVER (PARTITION BY sede_id ORDER BY version DESC) as rn
                    FROM snapshot
                    WHERE sede_id = :sede
                ) t WHERE rn > 2
            )
        """),
        {"sede": sede.id}
    )

    db.commit()
    return new_version