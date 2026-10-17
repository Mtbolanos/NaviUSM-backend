from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.api_keys.crud import create_api_key, list_api_keys, revoke_api_key
from app.api_keys.schemas import ApiKeyCreate, ApiKeyCreated, ApiKeyOut
from app.database import get_db
from app.models import Usuario
from app.security import get_current_user

router = APIRouter()
templates = Jinja2Templates(directory="templates")
templates.env.cache = None


@router.get("/admin/api-keys")
def api_keys_page(request: Request, user: Usuario = Depends(get_current_user)):
    return templates.TemplateResponse(request, "api_keys.html", {"user": user})


@router.get("/admin/api/api-keys", response_model=list[ApiKeyOut])
def list_keys(db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    return list_api_keys(db, user.organizacion_id)


@router.post("/admin/api/api-keys", response_model=ApiKeyCreated, status_code=201)
def create_key(payload: ApiKeyCreate, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    expires_at = payload.expires_at
    if expires_at is not None:
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= datetime.now(timezone.utc):
            raise HTTPException(422, "La fecha de expiración debe ser futura")
    api_key, raw_key = create_api_key(db, user.organizacion_id, user.id, payload.nombre.strip(), expires_at)
    return ApiKeyCreated(**ApiKeyOut.model_validate(api_key).model_dump(), key=raw_key)


@router.delete("/admin/api/api-keys/{key_id}")
def revoke_key(key_id: UUID, db: Session = Depends(get_db), user: Usuario = Depends(get_current_user)):
    if not revoke_api_key(db, key_id, user.organizacion_id):
        raise HTTPException(404, "API key no encontrada")
    return {"success": True}