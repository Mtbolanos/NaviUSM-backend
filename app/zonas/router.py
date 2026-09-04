from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario
from app.security import get_current_user
from app.zonas.crud import get_caracteristicas
from app.zonas.schemas import CaracteristicaOut

router = APIRouter()


@router.get("/admin/api/caracteristicas", response_model=list[CaracteristicaOut])
def list_caracteristicas(
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    return get_caracteristicas(db)
