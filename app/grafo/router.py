from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.database import get_db
from app.grafo.crud import get_latest_snapshot, publish_graph_data
from app.grafo.schemas import (
    PublishPayloadIn,
    PublishResultOut,
    nodos_fuera_del_area,
)
from app.models import Sede, Usuario
from app.security import get_current_user

router = APIRouter()
templates = Jinja2Templates(directory="templates")
templates.env.cache = None


@router.post("/admin/api/sedes/{sede_id}/publish", response_model=PublishResultOut)
def publish_graph(
    sede_id: str,
    payload: PublishPayloadIn,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    sede = db.query(Sede).filter(
        Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id
    ).first()
    if not sede:
        raise HTTPException(404, "Sede no encontrada o sin acceso")

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
    version = publish_graph_data(
        db, sede, payload.model_dump(by_alias=True, exclude_unset=True), user.organizacion_id
    )
    return PublishResultOut(version=version)

@router.get("/api/v1/public/sedes/{sede_id}/snapshot")
def get_public_snapshot(sede_id: str, db: Session = Depends(get_db)):
    snapshot = get_latest_snapshot(db, sede_id)
    if not snapshot:
        raise HTTPException(404, "Grafo no disponible para esta sede")
    return snapshot.payload
