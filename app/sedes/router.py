from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario
from app.security import get_current_user
from app.sedes.crud import create_sede, delete_sede, get_sedes_by_org

router = APIRouter()
templates = Jinja2Templates(directory="templates")
templates.env.cache = None

@router.get("/admin")
def admin_panel(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    sedes_data = [{"id": str(s.id), "lat": float(s.latitud), "lng": float(s.longitud), "zoom": s.zoom_defecto} for s in sedes]
    return templates.TemplateResponse(request, "admin.html", {"user": user, "sedes": sedes, "sedes_json": sedes_data})

@router.get("/admin/edificios")
def admin_edificios(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    sedes_data = [{"id": str(s.id), "lat": float(s.latitud), "lng": float(s.longitud), "zoom": s.zoom_defecto} for s in sedes]
    return templates.TemplateResponse(request, "gestion_edificios.html", {"user": user, "sedes": sedes, "sedes_json": sedes_data})

@router.get("/admin/sedes")
def admin_sedes(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    return templates.TemplateResponse(request, "gestion_sedes.html", {"user": user, "sedes": sedes, "sedes_json": []})
   
@router.post("/admin/api/sedes")
def create_sede_endpoint(
    payload: dict = Body(...),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    create_sede(
        db,
        org_id=user.organizacion_id,
        nombre=payload.get("nombre", "Nueva Sede"),
        lat=payload.get("lat", -33.036577),
        lng=payload.get("lng", -71.486578),
        zoom=payload.get("zoom", 18),
    )
    return {"success": True}


@router.delete("/admin/api/sedes/{sede_id}")
def delete_sede_endpoint(
    sede_id: str,
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    found = delete_sede(db, sede_id, user.organizacion_id)
    if not found:
        raise HTTPException(404, "Sede no encontrada")
    return {"success": True}
