from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exception_handlers import http_exception_handler

from app.api_keys.router import router as api_keys_router
from app.auth.router import router as auth_router
from app.config import settings
from app.geocode.router import router as geocode_router
from app.grafo.router import router as grafo_router
from app.mobile.router import router as mobile_router
from app.sedes.router import router as sedes_router
from app.zonas.router import router as zonas_router

app = FastAPI(
    title="NaviUSM API móvil",
    version="1.3.2",
    description=(
        "API de consumo para la app móvil.\n\n"
        "**Flujo:** `POST /api/v1/mobile/session` con el header `X-API-Key` → usar el `access_token` "
        "en `Authorization: Bearer <token>` → al recibir 401, pedir un token nuevo."
    ),
    docs_url="/docs" if settings.api_docs else None,
    redoc_url="/redoc" if settings.api_docs else None,
    openapi_url="/openapi.json" if settings.api_docs else None,
)

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
    # Solo las páginas HTML redirigen al login; las APIs devuelven el 401 en JSON
    is_api = request.url.path.startswith(("/api/", "/admin/api/"))
    if exc.status_code == 401 and not is_api:
        root_path = request.scope.get("root_path", "").rstrip("/")
        return RedirectResponse(url=f"{root_path}/login", status_code=303)
    return await http_exception_handler(request, exc)

@app.get("/static/{path:path}", name="static", include_in_schema=False)
def serve_static(path: str):
    absolute_path = (_BASE / "static" / path).resolve()
    
    static_root = (_BASE / "static").resolve()
    if not str(absolute_path).startswith(str(static_root)):
        raise HTTPException(status_code=403, detail="Acceso denegado")
        
    if absolute_path.is_file():
        return FileResponse(str(absolute_path))
        
    raise HTTPException(status_code=404, detail="Archivo no encontrado")

app.include_router(mobile_router)
app.include_router(auth_router, include_in_schema=False)
app.include_router(sedes_router, include_in_schema=False)
app.include_router(grafo_router, include_in_schema=False)
app.include_router(zonas_router, include_in_schema=False)
app.include_router(api_keys_router, include_in_schema=False)
app.include_router(geocode_router, include_in_schema=False)