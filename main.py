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

    # 1. Guardar Snapshot para la App Móvil (Offline)
    last_snap = db.query(Snapshot).filter(Snapshot.sede_id == sede.id).order_by(desc(Snapshot.version)).first()
    new_version = (last_snap.version + 1) if last_snap else 1
    new_snapshot = Snapshot(sede_id=sede.id, organizacion_id=user.organizacion_id, payload=payload, version=new_version)
    db.add(new_snapshot)
    
    # 2. Sincronización Espacial Inteligente (UPSERT)
    incoming_blds = []
    for b in payload.get("buildings", []):
        if b["id"] == 'exterior': continue
        incoming_blds.append(b["id"])
        db.execute(text("""
            INSERT INTO edificio (id, sede_id, organizacion_id, nombre, piso_min, piso_max)
            VALUES (:id, :sede, :org, :nombre, :p_min, :p_max)
            ON CONFLICT (id) DO UPDATE SET
                nombre = EXCLUDED.nombre,
                piso_min = EXCLUDED.piso_min,
                piso_max = EXCLUDED.piso_max
        """), {
            "id": b["id"], "sede": sede.id, "org": user.organizacion_id,
            "nombre": b["name"], "p_min": b["min"], "p_max": b["max"]
        })

    incoming_nodes = []
    for n in payload.get("nodes", []):
        incoming_nodes.append(n["id"])
        edificio_uuid = n.get("building") if n.get("building") != 'exterior' else None
        
        # Upsert de Nodo
        db.execute(text("""
            INSERT INTO nodo (id, sede_id, organizacion_id, geom, piso, tipo, edificio_id)
            VALUES (:id, :sede, :org, ST_SetSRID(ST_MakePoint(:lng, :lat, :piso), 4326), :piso, :tipo, :edificio_id)
            ON CONFLICT (id) DO UPDATE SET
                geom = EXCLUDED.geom,
                piso = EXCLUDED.piso,
                tipo = EXCLUDED.tipo,
                edificio_id = EXCLUDED.edificio_id
        """), {
            "id": n["id"], "sede": sede.id, "org": user.organizacion_id,
            "lng": n["lng"], "lat": n["lat"], "piso": n.get("floor", 1), "tipo": n["type"],
            "edificio_id": edificio_uuid
        })
        
        # Upsert de Puntos de Interés
        if n["type"] not in ["waypoint", "user"]:
            db.execute(text("""
                INSERT INTO poi (nodo_id, organizacion_id, nombre, categoria)
                VALUES (:nodo, :org, :nombre, :cat)
                ON CONFLICT (nodo_id) DO UPDATE SET
                    nombre = EXCLUDED.nombre,
                    categoria = EXCLUDED.categoria
            """), {
                "nodo": n["id"], "org": user.organizacion_id,
                "nombre": n["name"], "cat": n["type"]
            })
        else:
            # Si era POI y ahora es waypoint, borrar el POI
            db.execute(text("DELETE FROM poi WHERE nodo_id = :nodo"), {"nodo": n["id"]})

    incoming_edges = []
    for e in payload.get("edges", []):
        incoming_edges.append(e["id"])
        # Upsert de Arista
        db.execute(text("""
            INSERT INTO arista (id, origen_id, destino_id, organizacion_id, distancia)
            VALUES (:id, :origen, :destino, :org, :distancia)
            ON CONFLICT (id) DO UPDATE SET
                distancia = EXCLUDED.distancia
        """), {
            "id": e["id"], "origen": e["from"], "destino": e["to"],
            "org": user.organizacion_id, "distancia": e["weight"]
        })

    # Preparar Aristas para pgRouting asignando los 'gid' (secuencial) de los Nodos a source y target
    db.execute(text("""
        UPDATE arista a
        SET source = n1.gid, target = n2.gid
        FROM nodo n1, nodo n2
        WHERE a.origen_id = n1.id AND a.destino_id = n2.id
          AND a.organizacion_id = :org
    """), {"org": user.organizacion_id})

    # 3. Limpieza de huérfanos (Borrar lo que se eliminó en el editor web)
    if incoming_edges:
        db.execute(text("""
            DELETE FROM arista WHERE organizacion_id = :org AND id IN (
                SELECT a.id FROM arista a JOIN nodo n ON a.origen_id = n.id WHERE n.sede_id = :sede
            ) AND id != ALL(CAST(:in_edges AS uuid[]))
        """), {"org": user.organizacion_id, "sede": sede.id, "in_edges": incoming_edges})
    else:
        db.execute(text("DELETE FROM arista WHERE id IN (SELECT a.id FROM arista a JOIN nodo n ON a.origen_id = n.id WHERE n.sede_id = :sede)"), {"sede": sede.id})

    if incoming_nodes:
        db.execute(text("DELETE FROM nodo WHERE sede_id = :sede AND id != ALL(CAST(:in_nodes AS uuid[]))"), {"sede": sede.id, "in_nodes": incoming_nodes})
    else:
        db.execute(text("DELETE FROM nodo WHERE sede_id = :sede"), {"sede": sede.id})

    if incoming_blds:
        db.execute(text("DELETE FROM edificio WHERE sede_id = :sede AND id != ALL(CAST(:in_blds AS uuid[]))"), {"sede": sede.id, "in_blds": incoming_blds})
    else:
        db.execute(text("DELETE FROM edificio WHERE sede_id = :sede"), {"sede": sede.id})

    db.commit()
    return {"message": "Grafo publicado sin pérdida de integridad", "version": new_version}

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