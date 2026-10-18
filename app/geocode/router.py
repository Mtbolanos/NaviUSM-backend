import json
import time
import urllib.error
import urllib.parse
import urllib.request

from fastapi import APIRouter, Depends, HTTPException, Query

from app.config import settings
from app.models import Usuario
from app.security import get_current_user

router = APIRouter()

CACHE_TTL = 3600   # segundos
CACHE_MAX = 500    # entradas
_cache: dict[tuple, tuple[float, list]] = {}

# "Solo recintos": excluye calles, direcciones/localidades, límites administrativos y vías férreas
EXCLUIR_NO_RECINTOS = ["!highway", "!place", "!boundary", "!railway"]


def _buscar_photon(q: str, solo_recintos: bool, lat: float | None, lng: float | None) -> list[dict]:
    params = [("q", q), ("countrycode", settings.geocoder_country), ("limit", "8")]
    if lat is not None and lng is not None:
        params += [("lat", f"{lat:.5f}"), ("lon", f"{lng:.5f}")]  # prioriza resultados cerca del mapa visible
    if solo_recintos:
        params += [("osm_tag", tag) for tag in EXCLUIR_NO_RECINTOS]

    url = f"{settings.geocoder_url}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": settings.geocoder_user_agent})
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.load(resp)

    resultados = []
    for f in data.get("features", []):
        p = f.get("properties", {})
        lng_r, lat_r = f["geometry"]["coordinates"][:2]
        calle = " ".join(filter(None, [p.get("street"), p.get("housenumber")]))
        nombre = p.get("name") or calle or p.get("city") or "Sin nombre"
        partes = [calle if p.get("name") else None, p.get("district"), p.get("city"), p.get("state")]
        detalle = ", ".join(dict.fromkeys(x for x in partes if x))  # sin repetidos, manteniendo el orden
        resultados.append({"nombre": nombre, "detalle": detalle, "lat": lat_r, "lng": lng_r})
    return resultados


@router.get("/admin/api/geocode")
def geocode(
    q: str = Query(min_length=2, max_length=200),
    solo_recintos: bool = True,
    lat: float | None = Query(None, ge=-90, le=90),
    lng: float | None = Query(None, ge=-180, le=180),
    user: Usuario = Depends(get_current_user),
):
    q = q.strip()
    key = (q.lower(), solo_recintos, round(lat, 2) if lat is not None else None, round(lng, 2) if lng is not None else None)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_TTL:
        return hit[1]

    try:
        resultados = _buscar_photon(q, solo_recintos, lat, lng)
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError):
        raise HTTPException(502, "El servicio de mapas no está disponible")

    if len(_cache) >= CACHE_MAX:
        _cache.pop(next(iter(_cache)))  # descarta la entrada más antigua
    _cache[key] = (now, resultados)
    return resultados