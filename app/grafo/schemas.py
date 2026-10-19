from pydantic import BaseModel, Field
from uuid import UUID
from datetime import datetime


class SnapshotOut(BaseModel):
    id: UUID
    version: int
    published_at: datetime

    model_config = {"from_attributes": True}


class PisoCambio(BaseModel):
    numero: int
    nombre: str | None = Field(None, max_length=100)
    desde: int | None = None  # número que tenía antes; None si el piso es nuevo


class EdificioCambio(BaseModel):
    id: UUID
    nombre: str = Field(min_length=1, max_length=255)
    acceso: int
    pisos: list[PisoCambio] = Field(min_length=1)


class EdificiosPatch(BaseModel):
    base_version: int  # versión cargada por la página; si ya no es la última, 409
    edificios: list[EdificioCambio] = []
    eliminar: list[UUID] = []
