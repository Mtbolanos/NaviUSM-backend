from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import RedirectResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.exception_handlers import http_exception_handler, request_validation_exception_handler

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
    version="1.3.1",
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


# Rutas cuyo 422 se resume para el editor. Se compara contra la plantilla de la ruta, no contra
# la URL, para no depender del root_path ni del uuid.
_RUTAS_PUBLICACION = {"/admin/api/sedes/{sede_id}/publish"}
# Cuantos errores se nombran en `detail` antes de resumir; la lista completa va en `errores`.
_MAX_ERRORES_EN_DETAIL = 10


def _ubicacion(loc) -> str:
    """("body", "nodes", 3, "lat") -> "nodes[3].lat". El "body" inicial no le dice nada al editor."""
    partes = list(loc)
    if partes and partes[0] == "body":
        partes = partes[1:]
    texto = ""
    for p in partes:
        texto += f"[{p}]" if isinstance(p, int) else (f".{p}" if texto else str(p))
    return texto


def _resumen(errores: list[dict]) -> str:
    frases = []
    for e in errores[:_MAX_ERRORES_EN_DETAIL]:
        # pydantic antepone "Value error, " a los ValueError de los validadores propios
        msg = str(e["msg"]).removeprefix("Value error, ")
        donde = _ubicacion(e["loc"])
        frases.append(f"{donde}: {msg}" if donde else msg)
    resto = len(errores) - _MAX_ERRORES_EN_DETAIL
    if resto > 0:
        frases.append(f"y {resto} error(es) mas")
    return "; ".join(frases)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    """422 de la publicacion del grafo: resumido y sin el eco del payload.

    Las reglas que miran el payload completo (las de PublishPayloadIn) fallan a
    nivel del modelo, y pydantic adjunta en `input` el objeto que valido: el
    grafo entero. Un error de una linea devolvia 22 KB sobre un payload de 21,8
    KB, y crece con el campus. El editor solo necesita donde y por que, y lo
    muestra como texto (`${detail}` en static/js/admin.js), asi que `detail` es
    un string en espanol y la lista compacta (loc, msg, type) va en `errores`.

    El resto de las rutas (app movil, api-keys, ...) conserva el 422 por defecto
    de FastAPI.
    """
    ruta = request.scope.get("route")
    if getattr(ruta, "path", None) not in _RUTAS_PUBLICACION:
        return await request_validation_exception_handler(request, exc)
    errores = [
        {"loc": list(e.get("loc", [])), "msg": e.get("msg", ""), "type": e.get("type", "")}
        for e in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": _resumen(errores), "errores": errores})


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    public = ["/login", "/cambiar-contrasena"]
    if request.url.path in public or request.url.path.startswith("/static"):
        return await call_next(request)
    try:
        return await call_next(request)
    except HTTPException as exc:
        if exc.status_code == 401:
            root = request.scope.get("root_path", "")
            return RedirectResponse(f"{root}/login")
        raise

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