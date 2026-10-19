from uuid import UUID
from fastapi import APIRouter, Body, Depends, Header, HTTPException
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
from app.grafo.schemas import EdificiosPatch
from app.models import Sede, Usuario
from app.security import get_current_user

from app.templating import templates

router = APIRouter()

# Versión del snapshot en headers propios: Cloudflare debilita los ETag (W/) al comprimir, y estos no los toca
VERSION_HEADER = "X-Snapshot-Version"
CONFLICT_MSG = "El mapa se publicó desde otra página o pestaña después de que lo abriste"


def _get_sede(db: Session, sede_id: UUID, user: Usuario) -> Sede:
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id).first()
    if not sede:
        raise HTTPException(404, "Sede no encontrada o sin acceso")
    return sede


def _publish(db: Session, sede: Sede, payload: dict, org_id, base_version: int | None) -> JSONResponse:
    try:
        version = publish_graph_data(db, sede, payload, org_id, base_version)
    except PayloadOwnershipError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))
    except PayloadValidationError as exc:
        db.rollback()
        raise HTTPException(422, str(exc))
    except VersionConflictError as exc:
        db.rollback()
        raise HTTPException(409, CONFLICT_MSG, headers={VERSION_HEADER: str(exc.current)})
    return JSONResponse(
        {"message": "Grafo publicado sin pérdida de integridad", "version": version},
        headers={VERSION_HEADER: str(version)},
    )


@router.post("/admin/api/sedes/{sede_id}/publish")
def publish_graph(
    sede_id: UUID,
    payload: dict = Body(...),
    x_base_version: int | None = Header(None, description="Versión cargada por el editor; si ya no es la última, 409"),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    sede = _get_sede(db, sede_id, user)
    return _publish(db, sede, payload, user.organizacion_id, x_base_version)


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
