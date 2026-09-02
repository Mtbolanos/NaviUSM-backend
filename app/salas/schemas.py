from pydantic import BaseModel
from uuid import UUID


class SalaOut(BaseModel):
    id: UUID
    edificio_id: UUID
    piso: int
    nombre: str

    model_config = {"from_attributes": True}


class SalaCreate(BaseModel):
    piso: int
    nombre: str


class SalaUpdate(BaseModel):
    nombre: str
