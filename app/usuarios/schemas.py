from pydantic import BaseModel, EmailStr
from uuid import UUID
from datetime import datetime


class UsuarioCreate(BaseModel):
    email: EmailStr
    password: str
    rol: str = "editor"


class UsuarioOut(BaseModel):
    id: UUID
    email: str
    rol: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}
