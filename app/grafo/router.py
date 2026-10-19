import logging
import time
from uuid import UUID
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.database import get_db
from app.grafo.crud import (
    PayloadOwnershipError,
    PayloadValidationError,
    VersionConflictError,
    apply_building_changes,
    get_latest_snapshot,
    publish_graph_data,
)
from app.grafo.schemas import (
    EdificiosPatch,
    PublishPayloadIn,
    PublishResultOut,
    nodos_fuera_del_area,
)
from app.models import Sede, Usuario
from app.security import get_current_user
from app.validacion.topologia import validar_topologia

from app.templating import templates

router = APIRouter()
logger = logging.getLogger(__name__)


def _ms(desde: float) -> float:
    return round((time.perf_counter() - desde) * 1000, 2)

# Versión del snapshot en headers propios: Cloudflare debilita los ETag (W/) al comprimir, y estos no los toca
VERSION_HEADER = "X-Snapshot-Version"
CONFLICT_MSG = "El mapa se publicó desde otra página o pestaña después de que lo abriste"
PUBLISH_MSG = "Grafo publicado sin pérdida de integridad"


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


def _publish(
    db: Session, sede: Sede, payload: dict, org_id, base_version: int | None,
    inicio: float, tiempos: dict[str, float] | None = None,
) -> JSONResponse:
    """Publica y responde con el contrato comun del POST /publish y del PATCH /edificios.

    Nivel 3, modo informativo: corre despues del commit, sobre el mismo payload que se guardo,
    y solo reporta; validar_topologia no lanza, asi que no puede tumbar una publicacion hecha.
    DECISION PENDIENTE (integracion 1.3.1): la respuesta es la de origin/main
    ({"message", "version"} + X-Snapshot-Version) con `estado` y `validacion` agregados encima;
    el editor solo lee `version`.

    Observabilidad: cada etapa se cronometra y va en `tiempos_ms` y en el log. `publicacion` es
    publish_graph_data completo (normalizacion y validaciones de edificios, escritura, snapshot,
    retencion y commit).
    """
    tiempos = dict(tiempos or {})
    t = time.perf_counter()
    version = _publish_version(db, sede, payload, org_id, base_version)
    tiempos["publicacion"] = _ms(t)
    t = time.perf_counter()
    validacion = validar_topologia(payload)
    tiempos["nivel3"] = _ms(t)
    tiempos["total"] = _ms(inicio)
    logger.info(
        "publicacion sede=%s version=%d nodos=%d aristas=%d tiempos_ms=%s",
        sede.id, version, len(payload.get("nodes", [])), len(payload.get("edges", [])), tiempos,
    )
    resultado = PublishResultOut(message=PUBLISH_MSG, version=version, validacion=validacion, tiempos_ms=tiempos)
    return JSONResponse(resultado.model_dump(), headers={VERSION_HEADER: str(version)})


@router.post("/admin/api/sedes/{sede_id}/publish", response_model=PublishResultOut)
def publish_graph(
    sede_id: UUID,
    payload: PublishPayloadIn,
    x_base_version: int | None = Header(None, description="Versión cargada por el editor; si ya no es la última, 409"),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    inicio = time.perf_counter()
    sede = _get_sede(db, sede_id, user)

    # El area de la sede no se puede validar en el modelo: depende de la sede,
    # que recien se conoce aca. Se levanta como error de validacion para que pase
    # por el mismo handler que los de pydantic (app/main.py) y el editor tenga un
    # solo formato que leer.
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
    return _publish(db, sede, publicado, user.organizacion_id, x_base_version, inicio)


# Cambios de Gestión de Edificios: se aplican sobre la última versión publicada y crean una nueva.
# Sin Nivel 2: el payload no viene del cliente, lo arma el servidor desde el snapshot. El Nivel 3
# informativo si corre (en _publish), con la misma respuesta que el POST /publish.
@router.patch("/admin/api/sedes/{sede_id}/edificios", response_model=PublishResultOut)
def patch_edificios(
    sede_id: UUID,
    cambios: EdificiosPatch,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    inicio = time.perf_counter()
    sede = _get_sede(db, sede_id, user)
    snapshot = get_latest_snapshot(db, sede.id)
    if not snapshot:
        raise HTTPException(404, "Grafo no disponible para esta sede")
    if snapshot.version != cambios.base_version:
        raise HTTPException(409, CONFLICT_MSG, headers={VERSION_HEADER: str(snapshot.version)})
    try:
        payload = apply_building_changes(
            snapshot.payload,
            [c.model_dump(mode="json") for c in cambios.edificios],
            [str(e) for e in cambios.eliminar],
        )
    except PayloadValidationError as exc:
        raise HTTPException(422, str(exc))
    return _publish(db, sede, payload, user.organizacion_id, cambios.base_version, inicio)


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
