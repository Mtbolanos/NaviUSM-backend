# Importaciones a librerías python
from fastapi import FastAPI, Request, HTTPException, Depends, Response, Form, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import desc
import json

# Importaciones a módulos propios
from schemas import Login, ChangePassword
from auth import get_current_user, login_user, set_auth_cookie
from database import get_db
from models import Sede, Snapshot, Usuario
from crud import verify_password, change_user_password
app = FastAPI()

# Middleware para solicitar autenticación en rutas protegidas (como administración de mapa)
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in ["/login", "/cambiar-contrasena"]:  # Excluye públicas
        return await call_next(request)
    try:
        response = await call_next(request)
        return response
    except HTTPException as exc:
        if exc.status_code == 401:
            return RedirectResponse("/login")
        raise

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# ------- Rutas principales -------
# Check de autenticación en la raíz para redirigir a admin o login
@app.get("/")
async def root(request: Request, db: Session = Depends(get_db)):
    try:
        user = get_current_user(request, db)
        return RedirectResponse("/admin")
    except HTTPException as e:
        if e.status_code == 401:
            return RedirectResponse("/login")
        raise

@app.get("/login")
def get_login(request: Request):
    return templates.TemplateResponse(request=request, name="login.html", context={"request": request})

@app.post("/login")
def post_login(request: Request, email: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)):
    login_data = Login(email=email, password=password)
    try:
        user = login_user(db, login_data)
        redirect = RedirectResponse("/admin", status_code=303)
        set_auth_cookie(redirect, str(user.id))
        return redirect
    except HTTPException as e:
        if e.status_code == 400:
            return templates.TemplateResponse(request=request, name="login.html", context={"request": request, "error": "Credenciales inválidas"})
        raise

@app.get("/logout")
def logout(db: Session = Depends(get_db)):
    redirect = RedirectResponse("/login", status_code=303)
    redirect.delete_cookie("session")
    return redirect

@app.get("/cambiar-contrasena")
def get_change_password(request: Request, user: Usuario = Depends(get_current_user)):
    return templates.TemplateResponse(request=request, name="cambiar_contrasena.html", context={"request": request, "user": user})

@app.post("/cambiar-contrasena")
def post_change_password(request: Request, old_password: str = Form(...), new_password: str = Form(...), db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    if not verify_password(old_password, user.password_hash):
        return templates.TemplateResponse(request=request, name="cambiar_contrasena.html", context={"request": request, "user": user, "error": "La contraseña actual es incorrecta."})
    
    change_user_password(db, user, new_password)
    return templates.TemplateResponse(request=request, name="cambiar_contrasena.html", context={"request": request, "user": user, "success": "Contraseña actualizada exitosamente."})

# ------- Rutas de administración y mapa (protegidas) -------
@app.get("/admin")
def admin_panel(request: Request, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sedes = db.query(Sede).filter(Sede.organizacion_id == user.organizacion_id).all()
    sedes_data = [{"id": str(s.id), "lat": float(s.latitud), "lng": float(s.longitud), "zoom": s.zoom_defecto} for s in sedes]
    
    return templates.TemplateResponse(request=request, name="admin.html", context={
        "request": request, "user": user, "sedes": sedes, "sedes_json": sedes_data
    })
@app.post("/admin/api/sedes/{sede_id}/publish")
def publish_graph(sede_id: str, payload: dict = Body(...), db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id).first()
    if not sede:
        raise HTTPException(404, "Sede no encontrada o sin acceso")

    last_snap = db.query(Snapshot).filter(Snapshot.sede_id == sede.id).order_by(desc(Snapshot.version)).first()
    new_version = (last_snap.version + 1) if last_snap else 1

    new_snapshot = Snapshot(
        sede_id=sede.id,
        organizacion_id=user.organizacion_id,
        payload=payload,
        version=new_version
    )
    db.add(new_snapshot)
    
    # PostGIS (NODO, ARISTA, POI) pendiente de implementación.
    # Por ahora se persiste el Snapshot para habilitar el consumo del test.
    
    db.commit()
    return {"message": "Grafo publicado con éxito", "version": new_version}

# ------- Rutas de la App Móvil (API Pública y Test) -------
# Renderizar prototipo según sede
@app.get("/app-test/{sede_id}")
def get_mobile_test(request: Request, sede_id: str):
    return templates.TemplateResponse(request=request, name="mobile.html", context={"request": request, "sede_id": sede_id})

# Retorna el último snapshot disponible para una sede
@app.get("/api/v1/public/sedes/{sede_id}/snapshot")
def get_public_snapshot(sede_id: str, db: Session = Depends(get_db)):
    snapshot = db.query(Snapshot).filter(Snapshot.sede_id == sede_id).order_by(desc(Snapshot.version)).first()
    if not snapshot:
        raise HTTPException(404, "Grafo no disponible para esta sede")
    return snapshot.payload