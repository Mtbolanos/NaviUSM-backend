from uuid import UUID
from fastapi import APIRouter, Depends, Header, HTTPException
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


def _publish(db: Session, sede: Sede, payload: dict, org_id, base_version: int | None) -> JSONResponse:
    version = _publish_version(db, sede, payload, org_id, base_version)
    return JSONResponse(
        {"message": PUBLISH_MSG, "version": version},
        headers={VERSION_HEADER: str(version)},
    )


@router.post("/admin/api/sedes/{sede_id}/publish", response_model=PublishResultOut)
def publish_graph(
    sede_id: UUID,
    payload: PublishPayloadIn,
    x_base_version: int | None = Header(None, description="Versión cargada por el editor; si ya no es la última, 409"),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    sede = _get_sede(db, sede_id, user)

    # El area de la sede no se puede validar en el modelo: depende de la sede,
    # que recien se conoce aca. Se levanta con la misma forma que los errores de
    # pydantic para que el editor tenga un solo formato que leer.
    fuera = nodos_fuera_del_area(payload, float(sede.latitud), float(sede.longitud))
    if fuera:
        raise HTTPException(
            422,
            detail=[{
                "loc": ["body", "nodes"],
                "msg": f"nodos fuera del area de la sede (revisa si lat/lng vienen invertidos): {', '.join(fuera)}",
                "type": "value_error.fuera_de_area",
            }],
        )

    # exclude_unset preserva el payload tal como lo mando el editor: validar no
    # puede alterar el artefacto que se publica.
    publicado = payload.model_dump(by_alias=True, exclude_unset=True)
    version = _publish_version(db, sede, publicado, user.organizacion_id, x_base_version)
    # Nivel 3, modo informativo: reporta, no bloquea. Corre despues de publicar.
    # DECISION PENDIENTE (integracion 1.3.1): la respuesta es la de origin/main
    # ({"message", "version"} + X-Snapshot-Version) con `estado` y `validacion`
    # agregados encima; el editor solo lee `version`.
    resultado = PublishResultOut(message=PUBLISH_MSG, version=version, validacion=validar_topologia(publicado))
    return JSONResponse(resultado.model_dump(), headers={VERSION_HEADER: str(version)})


# Cambios de Gestión de Edificios: se aplican sobre la última versión publicada y crean una nueva
@router.patch("/admin/api/sedes/{sede_id}/edificios")
def patch_edificios(
    sede_id: UUID,
    cambios: EdificiosPatch,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
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
    return _publish(db, sede, payload, user.organizacion_id, cambios.base_version)


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
