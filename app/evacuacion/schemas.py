from pydantic import BaseModel
from uuid import UUID


class RutaEvacuacionCreate(BaseModel):
    nombre: str
    tipo_emergencia: str


class RutaEvacuacionOut(BaseModel):
    id: UUID
    nombre: str
    tipo_emergencia: str

    model_config = {"from_attributes": True}
