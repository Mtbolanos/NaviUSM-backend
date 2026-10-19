from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Usuario, Organizacion
from app.security import get_current_user
from app.sedes.crud import ContornoInvalido, create_sede, delete_sede, get_sedes_by_org, sedes_data, update_sede
from app.templating import templates

router = APIRouter()

@router.get("/admin")
def admin_panel(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    return templates.TemplateResponse(request, "admin.html", {"user": user, "sedes": sedes, "sedes_json": sedes_data(db, user.organizacion_id), "scope": "campus"})

@router.get("/admin/edificios")
def admin_edificios(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    return templates.TemplateResponse(request, "gestion_edificios.html", {"user": user, "sedes": sedes, "sedes_json": sedes_data(db, user.organizacion_id)})

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
    return templates.TemplateResponse(request, "editor_edificio.html", {
        "user": user, "sedes": sedes, "sedes_json": sedes_data(db, user.organizacion_id), "sede_actual": actual, "edificio_inicial": edificio or "", "scope": "building",
    })

@router.get("/admin/sedes")
def admin_sedes(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = get_sedes_by_org(db, user.organizacion_id)
    return templates.TemplateResponse(request, "gestion_sedes.html", {"user": user, "sedes": sedes, "sedes_json": sedes_data(db, user.organizacion_id)})
   
class SedeIn(BaseModel):
    nombre: str = Field(min_length=1, max_length=255)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    zoom: int = Field(default=18, ge=1, le=22)
    # Anillo exterior [[lng, lat], ...]; null = sin contorno
    contorno: list[list[float]] | None = None


@router.post("/admin/api/sedes")
def create_sede_endpoint(payload: SedeIn, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    nombre = payload.nombre.strip()
    if not nombre:
        raise HTTPException(422, "El nombre de la sede es obligatorio")
    try:
        sede = create_sede(db, org_id=user.organizacion_id, nombre=nombre, lat=payload.lat, lng=payload.lng,
                           zoom=payload.zoom, contorno=payload.contorno)
    except ContornoInvalido as e:
        db.rollback()
        raise HTTPException(422, str(e)) from None
    return {"success": True, "id": str(sede.id)}


@router.put("/admin/api/sedes/{sede_id}")
def update_sede_endpoint(sede_id: UUID, payload: SedeIn, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    nombre = payload.nombre.strip()
    if not nombre:
        raise HTTPException(422, "El nombre de la sede es obligatorio")
    try:
        found = update_sede(db, sede_id, user.organizacion_id, nombre, payload.lat, payload.lng, payload.zoom, payload.contorno)
    except ContornoInvalido as e:
        db.rollback()
        raise HTTPException(422, str(e)) from None
    if not found:
        raise HTTPException(404, "Sede no encontrada")
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