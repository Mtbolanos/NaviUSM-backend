from uuid import UUID
from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.database import get_db
from app.grafo.crud import PayloadOwnershipError, get_latest_snapshot, publish_graph_data
from app.models import Sede, Usuario
from app.security import get_current_user

router = APIRouter()
templates = Jinja2Templates(directory="templates")
templates.env.cache = None


@router.post("/admin/api/sedes/{sede_id}/publish")
def publish_graph(
    sede_id: UUID,
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    sede = db.query(Sede).filter(
        Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id
    ).first()
    if not sede:
        raise HTTPException(404, "Sede no encontrada o sin acceso")

    try:
        version = publish_graph_data(db, sede, payload, user.organizacion_id)
    except PayloadOwnershipError as exc:
        db.rollback()
        raise HTTPException(409, str(exc))
    return {"message": "Grafo publicado sin pérdida de integridad", "version": version}


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
        raise HTTPException(404, "Grafo no disponible para esta sede")
    return snapshot.payload