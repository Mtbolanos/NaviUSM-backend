"""Plantillas Jinja compartidas por todos los routers.

asset('css/admin.css') entrega la URL del archivo estático con ?v=<hash del contenido>: la versión
cambia sola cuando cambia el archivo, así que ni el navegador ni el caché de Cloudflare sirven una
copia vieja, y no hay que subir versiones a mano. El hash se recalcula solo si cambia el mtime.
"""
import hashlib
import os
from pathlib import Path

from fastapi.templating import Jinja2Templates
from jinja2 import pass_context

from app.config import settings

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

templates = Jinja2Templates(directory=str(STATIC_DIR.parent / "templates"))
templates.env.cache = None

_hashes: dict[str, tuple[float, str]] = {}


def _content_hash(path: str) -> str:
    full = STATIC_DIR / path
    try:
        mtime = os.path.getmtime(full)
    except OSError:
        return "0"
    cached = _hashes.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    with open(full, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()[:12]
    _hashes[path] = (mtime, digest)
    return digest


@pass_context
def asset(context, path: str) -> str:
    return f"{context.call(context['url_for'], 'static', path=path)}?v={_content_hash(path)}"


templates.env.globals["asset"] = asset
# Mapa base para las páginas con mapa; base.html lo deja en #site-config (NV.site().mapTiles)
templates.env.globals["map_tiles"] = {
    "url": settings.map_tile_url,
    "attribution": settings.map_tile_attribution,
    "max_zoom": settings.map_tile_max_zoom,
}
