from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exception_handlers import http_exception_handler

from app.auth.router import router as auth_router
from app.config import settings
from app.grafo.router import router as grafo_router
from app.salas.router import router as salas_router
from app.sedes.router import router as sedes_router
from app.zonas.router import router as zonas_router

app = FastAPI()

class ForwardedPrefixMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket"):
            headers = dict(scope.get("headers", []))
            if b"x-forwarded-prefix" in headers:
                scope["root_path"] = headers[b"x-forwarded-prefix"].decode("utf-8").rstrip("/")
        await self.app(scope, receive, send)

app.add_middleware(ForwardedPrefixMiddleware)

_BASE = Path(__file__).resolve().parent.parent

@app.exception_handler(HTTPException)
async def auth_exception_handler(request: Request, exc: HTTPException):
    if exc.status_code == 401:
        root_path = request.scope.get("root_path", "").rstrip("/")
        return RedirectResponse(url=f"{root_path}/login", status_code=303)
    return await http_exception_handler(request, exc)

@app.get("/static/{path:path}", name="static")
def serve_static(path: str):
    absolute_path = (_BASE / "static" / path).resolve()
    
    static_root = (_BASE / "static").resolve()
    if not str(absolute_path).startswith(str(static_root)):
        raise HTTPException(status_code=403, detail="Acceso denegado")
        
    if absolute_path.is_file():
        return FileResponse(str(absolute_path))
        
    raise HTTPException(status_code=404, detail="Archivo no encontrado")

app.include_router(auth_router)
app.include_router(sedes_router)
app.include_router(grafo_router)
app.include_router(zonas_router)
app.include_router(salas_router)

import os
from fastapi import Request

@app.get("/debug-static")
def debug_static(request: Request):
    static_dir = _BASE / "static"
    return {
        "base_dir_calculado": str(_BASE),
        "static_dir_calculado": str(static_dir),
        "existe_en_python": static_dir.exists(),
        "contenido_css": os.listdir(static_dir / "css") if (static_dir / "css").exists() else "Carpeta css no encontrada"
    }