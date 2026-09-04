from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Edificio, Sala, Usuario
from app.salas.crud import create_sala, delete_sala, get_salas_by_edificio, rename_sala
from app.salas.schemas import SalaCreate, SalaOut, SalaUpdate
from app.security import get_current_user

router = APIRouter()


def _get_edificio_or_404(db: Session, edificio_id: str, org_id) -> Edificio:
    edificio = db.query(Edificio).filter(Edificio.id == edificio_id, Edificio.organizacion_id == org_id).first()
    if not edificio:
        raise HTTPException(404, "Edificio no encontrado o sin acceso")
    return edificio


@router.get("/admin/api/edificios/{edificio_id}/salas", response_model=list[SalaOut])
def list_salas(
    edificio_id: str,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    _get_edificio_or_404(db, edificio_id, user.organizacion_id)
    return get_salas_by_edificio(db, edificio_id)


@router.post("/admin/api/edificios/{edificio_id}/salas", response_model=SalaOut)
def create_sala_endpoint(
    edificio_id: str,
    payload: SalaCreate,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    _get_edificio_or_404(db, edificio_id, user.organizacion_id)
    return create_sala(db, edificio_id, user.organizacion_id, payload.piso, payload.nombre)


@router.patch("/admin/api/salas/{sala_id}", response_model=SalaOut)
def rename_sala_endpoint(
    sala_id: str,
    payload: SalaUpdate,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    sala = db.query(Sala).filter(Sala.id == sala_id, Sala.organizacion_id == user.organizacion_id).first()
    if not sala:
        raise HTTPException(404, "Sala no encontrada")
    return rename_sala(db, sala_id, payload.nombre)


@router.delete("/admin/api/salas/{sala_id}")
def delete_sala_endpoint(
    sala_id: str,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    sala = db.query(Sala).filter(Sala.id == sala_id, Sala.organizacion_id == user.organizacion_id).first()
    if not sala:
        raise HTTPException(404, "Sala no encontrada")
    delete_sala(db, sala_id)
    return {"success": True}
