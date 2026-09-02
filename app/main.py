from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from app.auth.router import router as auth_router
from app.config import settings
from app.grafo.router import router as grafo_router
from app.salas.router import router as salas_router
from app.sedes.router import router as sedes_router
from app.zonas.router import router as zonas_router

app = FastAPI(root_path=settings.root_path)

_BASE = Path(__file__).parent.parent


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


app.mount("/static", StaticFiles(directory=str(_BASE / "static")), name="static")

app.include_router(auth_router)
app.include_router(sedes_router)
app.include_router(grafo_router)
app.include_router(zonas_router)
app.include_router(salas_router)
