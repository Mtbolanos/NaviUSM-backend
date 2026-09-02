from pydantic import BaseModel
from uuid import UUID


class CaracteristicaOut(BaseModel):
    id: UUID
    codigo: str
    nombre: str
    color_hex: str

    model_config = {"from_attributes": True}
