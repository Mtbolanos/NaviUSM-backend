from pydantic import BaseModel


class SedeCreate(BaseModel):
    nombre: str
    lat: float
    lng: float
    zoom: int = 18
