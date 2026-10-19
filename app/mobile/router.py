from uuid import UUID

import jwt
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security import APIKeyHeader, HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api_keys.crud import get_active_key_by_id, get_active_key_by_raw
from app.config import settings
from app.database import get_db
from app.grafo.crud import get_latest_snapshot
from app.mobile.session import decode_session_token, issue_session_token
from app.models import ApiKey, Organizacion, Sede

router = APIRouter(prefix="/api/v1/mobile", tags=["Móvil"])

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False, description="API key de la organización (nvu_…)")
bearer = HTTPBearer(auto_error=False, description="Token obtenido en POST /api/v1/mobile/session")

UNAUTHORIZED = {"WWW-Authenticate": "Bearer"}


class SessionOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int  # segundos


class SedeOut(BaseModel):
    uuid: str
    nombre: str
    lat: float
    lng: float
    zoom: int


class OrganizacionOut(BaseModel):
    id: str
    slug: str
    nombre: str
    sedes: list[SedeOut]


def require_session(
    credentials: HTTPAuthorizationCredentials | None = Security(bearer),
    db: Session = Depends(get_db),
) -> ApiKey:
    if credentials is None:
        raise HTTPException(401, "Falta el token de sesión", headers=UNAUTHORIZED)
    try:
        claims = decode_session_token(credentials.credentials)
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Token de sesión inválido o expirado", headers=UNAUTHORIZED)
    # Se revisa la key en cada request: revocarla corta el acceso de inmediato, sin esperar a que expire el token
    api_key = get_active_key_by_id(db, claims["sub"])
    if api_key is None or str(api_key.organizacion_id) != claims["org"]:
        raise HTTPException(401, "API key revocada o expirada", headers=UNAUTHORIZED)
    return api_key


@router.post(
    "/session",
    response_model=SessionOut,
    summary="Obtener token de sesión",
    responses={401: {"description": "API key ausente, inválida, revocada o expirada"}},
)
def create_session(raw_key: str | None = Security(api_key_header), db: Session = Depends(get_db)):
    """
    Intercambia la API key de la organización (header `X-API-Key`) por un token de sesión de corta duración.
    Usa el token en `Authorization: Bearer <token>` en el resto de los endpoints. Cuando expire (401),
    vuelve a llamar a este endpoint.

    *Futuro:* cuando se active la atestación de app, este endpoint exigirá además el token de
    App Attest / Play Integrity; el resto del flujo no cambia.
    """
    api_key = get_active_key_by_raw(db, raw_key or "")
    if api_key is None:
        raise HTTPException(401, "API key inválida, revocada o expirada")
    if settings.mobile_attestation != "off":
        raise HTTPException(501, "Atestación de app aún no implementada")
    token, ttl = issue_session_token(api_key.id, api_key.organizacion_id)
    return SessionOut(access_token=token, expires_in=ttl)


@router.get(
    "/organizacion",
    response_model=OrganizacionOut,
    summary="Organización y sedes",
    responses={401: {"description": "Token ausente, inválido o expirado"}},
)
def get_organizacion(api_key: ApiKey = Depends(require_session), db: Session = Depends(get_db)):
    """Datos de la organización dueña de la API key y la lista de sus sedes."""
    org = db.query(Organizacion).filter(Organizacion.id == api_key.organizacion_id).first()
    sedes = db.query(Sede).filter(Sede.organizacion_id == api_key.organizacion_id).order_by(Sede.nombre).all()
    return OrganizacionOut(
        id=str(org.id), slug=org.slug, nombre=org.nombre,
        sedes=[SedeOut(uuid=str(s.id), nombre=s.nombre, lat=float(s.latitud), lng=float(s.longitud), zoom=s.zoom_defecto) for s in sedes],
    )


@router.get(
    "/sedes/{sede_id}/snapshot",
    summary="Grafo publicado de una sede",
    responses={
        401: {"description": "Token ausente, inválido o expirado"},
        404: {"description": "La sede no existe, no pertenece a la organización o no tiene grafo publicado"},
    },
)
def get_snapshot(sede_id: UUID, api_key: ApiKey = Depends(require_session), db: Session = Depends(get_db)) -> dict:
    """
    Última versión publicada del grafo de la sede: `meta`, `buildings`, `nodes`, `edges` y `zonas`.

    Formato `meta.version = "2.2"`: cada edificio trae `acceso` (piso a nivel de la calle) y
    `pisos: [{numero, nombre}]` (lista explícita; `nombre` puede ser `null`). Reemplaza a `min`/`max`.
    Los nodos dentro de un edificio (`building` distinto de `"exterior"`) siempre están en uno de sus pisos.
    """
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == api_key.organizacion_id).first()
    snapshot = get_latest_snapshot(db, sede.id) if sede else None
    if not snapshot:
        raise HTTPException(404, "Grafo no disponible para esta sede")
    return snapshot.payload