import copy
import json
import logging
import time
from urllib.parse import unquote
from uuid import UUID
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.exc import DataError, IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.grafo import registro
from app.grafo.crud import (
    PayloadOwnershipError,
    PayloadValidationError,
    VersionConflictError,
    apply_building_changes,
    get_latest_snapshot,
    normalize_buildings,
    publish_graph_data,
)
from app.grafo.schemas import (
    EdificiosPatch,
    PublishPayloadIn,
    PublishResultOut,
    nodos_fuera_del_area,
)
from app.models import Publicacion, Sede, Snapshot, Usuario
from app.security import get_current_user
from app.validacion.topologia import RevisionNivel3, revisar_topologia

from app.templating import templates

router = APIRouter()
logger = logging.getLogger(__name__)


def _ms(desde: float) -> float:
    return round((time.perf_counter() - desde) * 1000, 2)

# Versión del snapshot en headers propios: Cloudflare debilita los ETag (W/) al comprimir, y estos no los toca
VERSION_HEADER = "X-Snapshot-Version"
CONFLICT_MSG = "El mapa se publicó desde otra página o pestaña después de que lo abriste"
PUBLISH_MSG = "Grafo publicado sin pérdida de integridad"
PUBLISH_ADV_MSG = "Grafo publicado: conectividad íntegra, con advertencias que no bloquean"
PUBLISH_ADV_NO_EVALUABLE_MSG = "Grafo publicado con advertencias que no bloquean"
PUBLISH_SIN_N3_MSG = "Grafo publicado sin validación topológica: el Nivel 3 falló"
FORZADO_MSG = "Grafo publicado forzado, con defectos de conectividad: ver advertencias"
SIN_CAMBIOS_MSG = "Sin cambios respecto a la versión vigente: no se creó una versión nueva"

# Override del bloqueo del Nivel 3 (decision 0003): el motivo del admin viaja en este header y no
# en el cuerpo, porque el cuerpo es el artefacto que se publica y validar no puede alterarlo.
# Los headers HTTP son latin-1: el cliente manda el motivo percent-encoded (encodeURIComponent) y
# aca se decodifica con urllib.parse.unquote; un valor ASCII sin escapes pasa igual. Vacio o solo
# espacios cuenta como ausente.
FORZAR_HEADER = "X-Forzar-Publicacion"
FORZAR_DESC = ("Motivo para publicar aunque el Nivel 3 encuentre defectos de conectividad; "
               "percent-encoded (UTF-8). Vacio = sin override")


def _motivo_forzado(valor: str | None) -> str | None:
    if valor is None:
        return None
    return unquote(valor).strip() or None


def _mensaje(revision: RevisionNivel3, forzado: bool) -> str:
    if forzado:
        return FORZADO_MSG
    if revision.reporte is None:
        return PUBLISH_SIN_N3_MSG
    if not revision.validacion.advertencias:
        return PUBLISH_MSG
    return PUBLISH_ADV_MSG if revision.reporte.conectividad_integra else PUBLISH_ADV_NO_EVALUABLE_MSG


def _version_sin_cambios(db: Session, sede_id, payload: dict) -> int | None:
    """La versión vigente si el payload no la cambia; None si cambia, si no hay vigente o si no se pudo comparar.

    La regla de qué cuenta como cambio vive en la base (diferencias_grafo, migracion 0010), la misma
    que usa el trigger de snapshot. Se compara contra una copia normalizada, porque publish_graph_data
    normaliza antes de guardar y la vigente ya esta normalizada. Si la comparación falla se publica
    igual: no poder comparar no es motivo para frenar una publicación.
    """
    try:
        vigente = get_latest_snapshot(db, sede_id)
        if vigente is None:
            return None
        nuevo = copy.deepcopy(payload)
        normalize_buildings(nuevo)
        diferencia = db.execute(
            text("SELECT public.diferencias_grafo(CAST(:a AS jsonb), CAST(:b AS jsonb))"),
            {"a": json.dumps(vigente.payload), "b": json.dumps(nuevo)},
        ).scalar()
        return vigente.version if diferencia is None else None
    except Exception:
        logger.exception("no se pudo comparar con la version vigente sede=%s; se publica", sede_id)
        return None


# Reglas del esquema (Nivel 1) con nombre propio: cuando PostgreSQL rechaza una escritura, el editor
# recibe un 422 que dice que regla fallo, en vez de un 500. Las de unicidad son diferidas (migracion
# 0011) y fallan en el commit de publish_graph_data, que igual ocurre dentro de _publish_version.
REGLAS_N1 = {
    "chk_arista_distancia_positiva": "una arista tiene distancia 0 o negativa",
    "excl_arista_par_unico": "hay dos aristas entre el mismo par de nodos (en cualquier dirección)",
    "excl_nodo_coordenada_piso": "hay dos nodos en la misma coordenada y el mismo piso",
    "chk_nodo_coordenadas_rango": "un nodo tiene coordenadas fuera de rango (latitud ±90, longitud ±180)",
    "chk_zona_geometria_valida": "una zona tiene una geometría inválida (polígono que se cruza o con puntos insuficientes)",
    "chk_origen_destino": "una arista une un nodo consigo mismo",
}


def _zonas_invalidas(db: Session, payload: dict) -> list[str]:
    """Nombres (o ids) de las zonas del envío cuya geometría PostGIS considera inválida. Vacío si no se pudo ver."""
    try:
        filas = db.execute(text("""
            SELECT coalesce(nullif(z->>'name', ''), z->>'id')
            FROM jsonb_array_elements(CAST(:zonas AS jsonb)) z
            WHERE NOT public.ST_IsValid(public.ST_GeomFromGeoJSON((z->'geojson')::text))
        """), {"zonas": json.dumps(payload.get("zonas", []))}).scalars().all()
        db.rollback()
        return list(filas)
    except Exception:
        db.rollback()
        return []


def _detalle_n1(exc: Exception, db: Session, payload: dict) -> str:
    """Texto legible del rechazo del esquema: la regla si tiene nombre propio, si no el error de PostgreSQL."""
    diag = getattr(getattr(exc, "orig", None), "diag", None)
    regla = getattr(diag, "constraint_name", None)
    if regla == "chk_zona_geometria_valida":
        cuales = _zonas_invalidas(db, payload)
        if cuales:
            return f"Regla del esquema (Nivel 1): {REGLAS_N1[regla]}: {', '.join(cuales)} ({regla})"
    if regla in REGLAS_N1:
        return f"Regla del esquema (Nivel 1): {REGLAS_N1[regla]} ({regla})"
    primaria = getattr(diag, "message_primary", None) or str(getattr(exc, "orig", exc)).splitlines()[0]
    return f"Regla del esquema (Nivel 1): {primaria[:300]}"


def _get_sede(db: Session, sede_id: UUID, user: Usuario) -> Sede:
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id).first()
    if not sede:
        raise HTTPException(404, "Sede no encontrada o sin acceso")
    return sede


def _publish_version(db: Session, sede: Sede, payload: dict, org_id, base_version: int | None) -> int:
    try:
        return publish_graph_data(db, sede, payload, org_id, base_version)
    except PayloadOwnershipError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))
    except PayloadValidationError as exc:
        db.rollback()
        raise HTTPException(422, str(exc))
    except VersionConflictError as exc:
        db.rollback()
        raise HTTPException(409, CONFLICT_MSG, headers={VERSION_HEADER: str(exc.current)})
    except (IntegrityError, DataError) as exc:
        db.rollback()
        raise HTTPException(422, _detalle_n1(exc, db, payload))


def _contexto(request: Request, sede: Sede, user: Usuario, origen: str) -> dict:
    """Lo que el registro necesita, tomado como valores apenas se resuelve la sede: despues de un
    rollback la sesion expira los objetos y leer sede.id volveria a consultar la base."""
    return {
        "sede_id": sede.id, "organizacion_id": user.organizacion_id, "usuario_id": getattr(user, "id", None),
        "origen": origen, "bytes": registro.bytes_recibidos(request),
    }


def _rechazo(ctx: dict, status_http: int, motivo, inicio: float, payload=None) -> None:
    registro.registrar(
        **ctx, resultado="rechazado", status_http=status_http, motivo=motivo,
        tiempos_ms={"total": _ms(inicio)}, conteos=registro.conteos(payload),
    )


def _publish(
    db: Session, sede: Sede, payload: dict, org_id, base_version: int | None,
    inicio: float, tiempos: dict[str, float] | None = None, *, ctx: dict, forzar: str | None = None,
) -> JSONResponse:
    """Valida el Nivel 3, publica y responde con el contrato comun del POST /publish y del PATCH /edificios.

    Nivel 3 antes de escribir (decision 0003, «publicar = promover»): revisar_topologia corre sobre
    el payload que se va a guardar, antes de publish_graph_data. Tres desenlaces:

    - defecto de conectividad y sin override: no se escribe nada; 422
      {"detail", "estado": "bloqueado", "validacion"} y fila 'bloqueado_n3'.
    - defecto y override (`forzar`, el motivo del header X-Forzar-Publicacion): se publica;
      200 con estado 'publicado_forzado' y fila 'publicado_forzado' con el motivo del admin.
    - sin defecto: se publica; 200 'publicado'. Un override sin defecto se ignora.

    La accesibilidad (sin escaleras) nunca bloquea: va en las advertencias. Si el validador falla,
    se publica con nivel3_ejecutado=false (ver revisar_topologia).
    La respuesta 200 es la de origin/main ({"message", "version"} + X-Snapshot-Version) con
    `estado`, `validacion` y `tiempos_ms` agregados; el editor solo lee `version`.

    Observabilidad: cada etapa se cronometra y va en `tiempos_ms` y en el log. `nivel3` es
    revisar_topologia; `publicacion` es publish_graph_data completo (normalizacion y validaciones
    de edificios, escritura, snapshot, retencion y commit).

    Registro (app/grafo/registro.py): exito, bloqueo o rechazo dejan una fila en `publicacion`,
    escrita en una sesion propia y despues de que la de la solicitud solto su transaccion (FOR
    UPDATE de la sede). No toca la respuesta: el registro no lanza.
    """
    tiempos = dict(tiempos or {})
    # Sin cambios respecto a la vigente: no se escribe nada ni se crea versión (antes del N3: no hay
    # nada nuevo que validar, y una vigente publicada con override no debe quedar bloqueada al repetirla).
    # El X-Base-Version no se revisa en este camino: un envío idéntico no puede pisar el trabajo de otro.
    t = time.perf_counter()
    vigente = _version_sin_cambios(db, sede.id, payload)
    tiempos["comparacion"] = _ms(t)
    if vigente is not None:
        db.rollback()
        tiempos["total"] = _ms(inicio)
        logger.info("publicacion sin cambios sede=%s version=%d tiempos_ms=%s", sede.id, vigente, tiempos)
        registro.registrar(
            **ctx, resultado="sin_cambios", status_http=200, tiempos_ms=tiempos, conteos=registro.conteos(payload),
        )
        cuerpo = PublishResultOut(message=SIN_CAMBIOS_MSG, version=vigente, estado="sin_cambios", tiempos_ms=tiempos)
        return JSONResponse(cuerpo.model_dump(), headers={VERSION_HEADER: str(vigente)})

    t = time.perf_counter()
    revision = revisar_topologia(payload)
    tiempos["nivel3"] = _ms(t)
    validacion = revision.validacion.model_dump()
    forzado = revision.bloquea and forzar is not None

    if revision.bloquea and not forzado:
        # Nada se escribio todavia; el rollback solo suelta la transaccion de lectura de la sesion
        # antes de registrar desde otra conexion.
        db.rollback()
        motivo = revision.reporte.motivo_bloqueo()
        tiempos["total"] = _ms(inicio)
        logger.info("publicacion bloqueada por N3 sede=%s motivo=%s tiempos_ms=%s", sede.id, motivo, tiempos)
        registro.registrar(
            **ctx, resultado="bloqueado_n3", status_http=422, motivo=motivo,
            tiempos_ms=tiempos, validacion=validacion, conteos=registro.conteos(payload),
        )
        return JSONResponse({"detail": motivo, "estado": "bloqueado", "validacion": validacion}, status_code=422)

    t = time.perf_counter()
    try:
        version = _publish_version(db, sede, payload, org_id, base_version)
    except HTTPException as exc:
        # _publish_version ya hizo rollback
        _rechazo(ctx, exc.status_code, exc.detail, inicio, payload)
        raise
    except Exception as exc:
        # 500 a mitad de publish_graph_data: soltar el FOR UPDATE de la sede antes de registrar
        # desde otra conexion (si no, el INSERT espera a la propia solicitud). get_db cerraria la
        # sesion igual; el rollback solo se adelanta.
        try:
            db.rollback()
        except Exception:
            logger.exception("rollback fallido tras error en la publicacion")
        _rechazo(ctx, 500, f"{type(exc).__name__}: {exc}", inicio, payload)
        raise
    tiempos["publicacion"] = _ms(t)
    tiempos["total"] = _ms(inicio)
    estado = "publicado_forzado" if forzado else "publicado"
    logger.info(
        "publicacion sede=%s version=%d estado=%s nodos=%d aristas=%d tiempos_ms=%s",
        sede.id, version, estado, len(payload.get("nodes", [])), len(payload.get("edges", [])), tiempos,
    )
    resultado = PublishResultOut(
        message=_mensaje(revision, forzado), version=version, estado=estado,
        validacion=revision.validacion, tiempos_ms=tiempos,
    )
    cuerpo = resultado.model_dump()
    registro.registrar(
        **ctx, resultado=estado, status_http=200, version=version, motivo=forzar if forzado else None,
        tiempos_ms=cuerpo["tiempos_ms"], validacion=cuerpo["validacion"], conteos=registro.conteos(payload),
    )
    return JSONResponse(cuerpo, headers={VERSION_HEADER: str(version)})


@router.post("/admin/api/sedes/{sede_id}/publish", response_model=PublishResultOut)
def publish_graph(
    request: Request,
    sede_id: UUID,
    payload: PublishPayloadIn,
    x_base_version: int | None = Header(None, description="Versión cargada por el editor; si ya no es la última, 409"),
    x_forzar_publicacion: str | None = Header(None, alias=FORZAR_HEADER, description=FORZAR_DESC),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    inicio = time.perf_counter()
    sede = _get_sede(db, sede_id, user)
    ctx = _contexto(request, sede, user, "publish")

    # El area de la sede no se puede validar en el modelo: depende de la sede,
    # que recien se conoce aca. Se levanta como error de validacion para que pase
    # por el mismo handler que los de pydantic (app/main.py) y el editor tenga un
    # solo formato que leer. El rechazo se registra alla, junto con los del Nivel 2.
    fuera = nodos_fuera_del_area(payload, float(sede.latitud), float(sede.longitud))
    if fuera:
        raise RequestValidationError([{
            "loc": ("body", "nodes"),
            "msg": f"nodos fuera del area de la sede (revisa si lat/lng vienen invertidos): {', '.join(fuera)}",
            "type": "value_error.fuera_de_area",
        }])

    # exclude_unset preserva el payload tal como lo mando el editor: validar no
    # puede alterar el artefacto que se publica.
    publicado = payload.model_dump(by_alias=True, exclude_unset=True)
    return _publish(
        db, sede, publicado, user.organizacion_id, x_base_version, inicio,
        ctx=ctx, forzar=_motivo_forzado(x_forzar_publicacion),
    )


# Cambios de Gestión de Edificios: se aplican sobre la última versión publicada y crean una nueva.
# Sin Nivel 2: el payload no viene del cliente, lo arma el servidor desde el snapshot. El Nivel 3
# si corre antes de escribir (en _publish), con el mismo bloqueo, override y respuesta que el
# POST /publish: un cambio de edificios que deja POIs sin ruta (p. ej. borrar un piso con sus
# nodos) no se publica, y un grafo publicado que ya tenia defectos solo se edita forzando.
@router.patch("/admin/api/sedes/{sede_id}/edificios", response_model=PublishResultOut)
def patch_edificios(
    request: Request,
    sede_id: UUID,
    cambios: EdificiosPatch,
    x_forzar_publicacion: str | None = Header(None, alias=FORZAR_HEADER, description=FORZAR_DESC),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    inicio = time.perf_counter()
    sede = _get_sede(db, sede_id, user)
    ctx = _contexto(request, sede, user, "patch_edificios")
    snapshot = get_latest_snapshot(db, sede.id)
    if not snapshot:
        # Sin grafo no hay nada que publicar: no se registra (no es una ejecucion del pipeline)
        raise HTTPException(404, "Grafo no disponible para esta sede")
    if snapshot.version != cambios.base_version:
        _rechazo(ctx, 409, CONFLICT_MSG, inicio, snapshot.payload)
        raise HTTPException(409, CONFLICT_MSG, headers={VERSION_HEADER: str(snapshot.version)})
    try:
        payload = apply_building_changes(
            snapshot.payload,
            [c.model_dump(mode="json") for c in cambios.edificios],
            [str(e) for e in cambios.eliminar],
        )
    except PayloadValidationError as exc:
        _rechazo(ctx, 422, str(exc), inicio, snapshot.payload)
        raise HTTPException(422, str(exc))
    return _publish(
        db, sede, payload, user.organizacion_id, cambios.base_version, inicio,
        ctx=ctx, forzar=_motivo_forzado(x_forzar_publicacion),
    )


# Snapshot para el editor del panel: sesión de admin y solo sedes de su organización
@router.get("/admin/api/sedes/{sede_id}/snapshot")
def get_admin_snapshot(
    sede_id: UUID,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id).first()
    snapshot = get_latest_snapshot(db, sede.id) if sede else None
    if not snapshot:
        # Sin grafo, la versión base para el primer publish es 0
        raise HTTPException(404, "Grafo no disponible para esta sede", headers={VERSION_HEADER: "0"})
    return JSONResponse(
        snapshot.payload,
        headers={VERSION_HEADER: str(snapshot.version), "Cache-Control": "no-store"},
    )


# Versiones publicadas de una sede con lo que cambió en cada una (snapshot.cambios, migracion 0010),
# sin el grafo completo. Misma auth y filtro por organizacion que el historial de ejecuciones.
@router.get("/admin/api/sedes/{sede_id}/versiones")
def get_versiones(
    sede_id: UUID,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    filas = (
        db.query(Snapshot.version, Snapshot.published_at, Snapshot.cambios, Snapshot.restaurada_de)
        .filter(Snapshot.sede_id == sede_id, Snapshot.organizacion_id == user.organizacion_id)
        .order_by(Snapshot.version.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "version": f.version, "published_at": f.published_at.isoformat() if f.published_at else None,
            "cambios": f.cambios, "restaurada_de": f.restaurada_de,
        }
        for f in filas
    ]


# Historial de ejecuciones del publish (tabla publicacion): misma auth y filtro por organizacion
# que el snapshot del editor. Lo mas reciente primero.
@router.get("/admin/api/sedes/{sede_id}/publicaciones")
def get_publicaciones(
    sede_id: UUID,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    filas = (
        db.query(Publicacion)
        .filter(Publicacion.sede_id == sede_id, Publicacion.organizacion_id == user.organizacion_id)
        .order_by(Publicacion.publicado_en.desc())
        .limit(limit)
        .all()
    )
    return [
        {
            "id": str(f.id), "version": f.version, "publicado_en": f.publicado_en.isoformat(),
            "usuario_id": str(f.usuario_id) if f.usuario_id else None, "origen": f.origen,
            "resultado": f.resultado, "status_http": f.status_http, "motivo": f.motivo,
            "tiempos_ms": f.tiempos_ms, "validacion": f.validacion, "bytes": f.bytes, "conteos": f.conteos,
        }
        for f in filas
    ]
