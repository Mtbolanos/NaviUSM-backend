from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ApiKeyCreate(BaseModel):
    nombre: str = Field(min_length=1, max_length=255)
    expires_at: datetime | None = None


class ApiKeyOut(BaseModel):
    model_config = {"from_attributes": True}

    id: UUID
    nombre: str
    prefijo: str
    created_at: datetime
    expires_at: datetime | None
    last_used_at: datetime | None
    revoked_at: datetime | None


class ApiKeyCreated(ApiKeyOut):
    key: str  # solo se entrega al crearla