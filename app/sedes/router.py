from fastapi import APIRouter, Body, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import Usuario, Organizacion
from app.security import get_current_user
from app.sedes.crud import create_sede, delete_sede, get_sedes_by_org

from app.templating import templates

router = APIRouter()

@router.get("/admin")
def admin_panel(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    sedes_data = [{"id": str(s.id), "lat": float(s.latitud), "lng": float(s.longitud), "zoom": s.zoom_defecto} for s in sedes]
    return templates.TemplateResponse(request, "admin.html", {"user": user, "sedes": sedes, "sedes_json": sedes_data, "scope": "campus"})

@router.get("/admin/edificios")
def admin_edificios(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    sedes_data = [{"id": str(s.id), "lat": float(s.latitud), "lng": float(s.longitud), "zoom": s.zoom_defecto} for s in sedes]
    return templates.TemplateResponse(request, "gestion_edificios.html", {"user": user, "sedes": sedes, "sedes_json": sedes_data})

# Editor del interior de un edificio: mismo editor, limitado al edificio (se cambia de edificio sin recargar)
@router.get("/admin/edificios/editar")
def admin_editar_edificio(
    request: Request, sede: str | None = None, edificio: str | None = None,
    db: Session = Depends(get_db), user: Usuario = Depends(get_current_user),
):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    actual = next((s for s in sedes if str(s.id) == sede), None)
    if actual is None:
        return RedirectResponse(f"{request.scope.get('root_path', '')}/admin/edificios", status_code=303)
    sedes_data = [{"id": str(s.id), "lat": float(s.latitud), "lng": float(s.longitud), "zoom": s.zoom_defecto} for s in sedes]
    return templates.TemplateResponse(request, "editor_edificio.html", {
        "user": user, "sedes": sedes, "sedes_json": sedes_data, "sede_actual": actual, "edificio_inicial": edificio or "", "scope": "building",
    })

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