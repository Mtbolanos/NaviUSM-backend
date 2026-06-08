# Importaciones a librerías python
from fastapi import FastAPI, Request, HTTPException, Depends, Response, Form, Body
from fastapi.staticfiles import StaticFiles
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from sqlalchemy import desc, text
import json
import uuid
from pathlib import Path

# Importaciones a módulos propios
from schemas import Login, ChangePassword
from auth import get_current_user, login_user, set_auth_cookie
from database import get_db
from models import Sede, Snapshot, Usuario
from crud import verify_password, change_user_password
app = FastAPI(root_path="/naviusm")

# Middleware para solicitar autenticación en rutas protegidas (como administración de mapa)
@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if request.url.path in ["/login", "/cambiar-contrasena"] or request.url.path.startswith("/static"): # Excluye públicas y estáticas
        return await call_next(request)
    try:
        response = await call_next(request)
        return response
    except HTTPException as exc:
            if exc.status_code == 401:
                return RedirectResponse(f"{request.scope.get('root_path', '')}/login")
            raise

app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")
templates = Jinja2Templates(directory="templates")

# ------- Rutas principales -------
# Check de autenticación en la raíz para redirigir a admin o login
@app.get("/")
async def root(request: Request, db: Session = Depends(get_db)):
    try:
        user = get_current_user(request, db)
        return RedirectResponse(f"{request.scope.get('root_path', '')}/admin")
    except HTTPException as e:
        if e.status_code == 401:
            return RedirectResponse(f"{request.scope.get('root_path', '')}/login")
        raise

@app.get("/login")
def get_login(request: Request):
    return templates.TemplateResponse(request=request, name="login.html", context={"request": request})

@app.post("/login")
def post_login(request: Request, email: str = Form(...), password: str = Form(...), db: Session = Depends(get_db)):
    login_data = Login(email=email, password=password)
    try:
        user = login_user(db, login_data)
        redirect = RedirectResponse(f"{request.scope.get('root_path', '')}/admin", status_code=303)
        set_auth_cookie(redirect, str(user.id))
        return redirect
    except HTTPException as e:
        if e.status_code == 400:
            return templates.TemplateResponse(request=request, name="login.html", context={"request": request, "error": "Credenciales inválidas"})
        raise

@app.get("/logout")
def logout(request: Request, db: Session = Depends(get_db)):
    redirect = RedirectResponse(f"{request.scope.get('root_path', '')}/login", status_code=303)
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

# --- CRUD DE SEDES ---
@app.post("/admin/api/sedes")
def create_sede(payload: dict = Body(...), db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    nueva_sede = Sede(
        organizacion_id=user.organizacion_id,
        nombre=payload.get("nombre", "Nueva Sede"),
        latitud=payload.get("lat", -33.036577),
        longitud=payload.get("lng", -71.486578),
        zoom_defecto=payload.get("zoom", 18)
    )
    db.add(nueva_sede)
    db.commit()
    return {"success": True}

@app.delete("/admin/api/sedes/{sede_id}")
def delete_sede(sede_id: str, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id).first()
    if not sede:
        raise HTTPException(404, "Sede no encontrada")
    db.delete(sede)
    db.commit()
    return {"success": True}

# --- Publicación de Snapshot PostGIS ---
@app.post("/admin/api/sedes/{sede_id}/publish")
def publish_graph(sede_id: str, payload: dict = Body(...), db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id).first()
    if not sede:
        raise HTTPException(404, "Sede no encontrada o sin acceso")

    # 1. Guardar Snapshot (Para el consumo offline del móvil)
    last_snap = db.query(Snapshot).filter(Snapshot.sede_id == sede.id).order_by(desc(Snapshot.version)).first()
    new_version = (last_snap.version + 1) if last_snap else 1

    new_snapshot = Snapshot(
        sede_id=sede.id,
        organizacion_id=user.organizacion_id,
        payload=payload,
        version=new_version
    )
    db.add(new_snapshot)
    
    # 2. Desempaquetado espacial en PostGIS
    db.execute(text("DELETE FROM nodo WHERE sede_id = :sede_id"), {"sede_id": sede.id})
    id_map = {}
    
    for n in payload.get("nodes", []):
        real_uuid = str(uuid.uuid4())
        id_map[n["id"]] = real_uuid
        
        # Leemos la variable tridimensional (piso) inyectada por el nuevo editor
        piso_actual = n.get("floor", 1)
        
        db.execute(text("""
            INSERT INTO nodo (id, sede_id, organizacion_id, geom, piso, tipo)
            VALUES (:id, :sede, :org, ST_SetSRID(ST_MakePoint(:lng, :lat, :piso), 4326), :piso, :tipo)
        """), {
            "id": real_uuid, "sede": sede.id, "org": user.organizacion_id,
            "lng": n["lng"], "lat": n["lat"], "piso": piso_actual, "tipo": n["type"]
        })
        
        if n["type"] not in ["waypoint", "user"]:
            db.execute(text("""
                INSERT INTO poi (nodo_id, organizacion_id, nombre, categoria)
                VALUES (:nodo, :org, :nombre, :cat)
            """), {
                "nodo": real_uuid, "org": user.organizacion_id,
                "nombre": n["name"], "cat": n["type"]
            })

    for e in payload.get("edges", []):
        origen_uuid = id_map.get(e["from"])
        destino_uuid = id_map.get(e["to"])
        
        if origen_uuid and destino_uuid:
            db.execute(text("""
                INSERT INTO arista (id, origen_id, destino_id, organizacion_id, distancia)
                VALUES (:id, :origen, :destino, :org, :distancia)
            """), {
                "id": str(uuid.uuid4()), "origen": origen_uuid, "destino": destino_uuid,
                "org": user.organizacion_id, "distancia": e["weight"]
            })

    db.commit()
    return {"message": "Grafo publicado y procesado espacialmente", "version": new_version}

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