from datetime import datetime
from math import cos, radians
from typing import Annotated, Any
from uuid import UUID

from pydantic import AfterValidator, BaseModel, Field, model_validator


class SnapshotOut(BaseModel):
    id: UUID
    version: int
    published_at: datetime

    model_config = {"from_attributes": True}


# --- Validacion de entrada del publish (Nivel 2) ---------------------------
#
# El payload entra, se guarda verbatim como snapshot y se sirve verbatim al
# telefono. No hay etapa intermedia que lo limpie, y el esquema solo aporta un
# CHECK (chk_origen_destino), asi que lo que no se valide aca queda publicado.
#
# Los ids viajan como str y no como UUID a proposito: el payload validado se
# guarda tal cual en una columna JSONB, y un uuid.UUID no es serializable a
# JSON. Mismo motivo para no tipar `building` como UUID.

EXTERIOR = "exterior"

# Radio alrededor del centro de la sede dentro del cual tiene que caer todo
# nodo. Generoso a proposito: no acota el campus, detecta el lat/lng invertido,
# que hoy ST_MakePoint acepta sin chistar y manda el nodo al Oceano Indico.
RADIO_SEDE_KM = 2.0

# Tipos de nodo que generan una fila en `poi` y por lo tanto necesitan nombre
# (app/grafo/crud.py:75 y :88).
TIPOS_SIN_POI = {"waypoint", "user"}


def _es_uuid(valor: str) -> str:
    try:
        UUID(valor)
    except (AttributeError, TypeError, ValueError):
        raise ValueError("debe ser un UUID valido")
    return valor


def _es_uuid_o_exterior(valor: str) -> str:
    if valor == EXTERIOR:
        return valor
    return _es_uuid(valor)


UuidStr = Annotated[str, AfterValidator(_es_uuid)]
EdificioRef = Annotated[str, AfterValidator(_es_uuid_o_exterior)]


class _PayloadBase(BaseModel):
    # `extra=allow` no es descuido: el editor es de otra linea y manda campos
    # que el pipeline ignora (`icon`, `meta`). Con el default de pydantic esos
    # campos se perderian del snapshot publicado al hacer model_dump().
    model_config = {"extra": "allow", "populate_by_name": True}


class BuildingIn(_PayloadBase):
    id: UuidStr
    name: str = Field(min_length=1)
    min: int
    max: int

    @model_validator(mode="after")
    def _rango_de_pisos_coherente(self):
        if self.min > self.max:
            raise ValueError(f"edificio '{self.name}': piso minimo {self.min} mayor que el maximo {self.max}")
        return self


class NodeIn(_PayloadBase):
    id: UuidStr
    type: str = Field(min_length=1)
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    # Obligatorio a proposito. crud.py usa n.get("floor", 1), que manda al piso
    # 1 cualquier nodo sin piso sin avisarle a nadie.
    floor: int
    building: EdificioRef
    name: str | None = None

    @model_validator(mode="after")
    def _los_poi_necesitan_nombre(self):
        if self.type not in TIPOS_SIN_POI and not (self.name or "").strip():
            raise ValueError(f"el nodo {self.id} es de tipo '{self.type}' y necesita nombre")
        return self


class EdgeIn(_PayloadBase):
    id: UuidStr
    desde: UuidStr = Field(alias="from")
    hasta: UuidStr = Field(alias="to")
    # Peso cero o negativo rompe A*. El esquema no lo impide: no hay
    # CHECK (distancia > 0).
    weight: float = Field(gt=0)

    @model_validator(mode="after")
    def _sin_self_loops(self):
        if self.desde == self.hasta:
            raise ValueError(f"la arista {self.id} une un nodo consigo mismo")
        return self


class ZonaIn(_PayloadBase):
    id: UuidStr
    geojson: dict[str, Any]
    name: str | None = None
    building: EdificioRef | None = None
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    tags: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _geojson_con_forma_de_geometria(self):
        faltantes = [k for k in ("type", "coordinates") if k not in self.geojson]
        if faltantes:
            raise ValueError(f"zona {self.id}: al geojson le falta {', '.join(faltantes)}")
        return self


class PublishPayloadIn(_PayloadBase):
    buildings: list[BuildingIn] = Field(default_factory=list)
    nodes: list[NodeIn] = Field(default_factory=list)
    edges: list[EdgeIn] = Field(default_factory=list)
    zonas: list[ZonaIn] = Field(default_factory=list)
    meta: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _ids_unicos(self):
        for nombre, items in (
            ("edificios", self.buildings),
            ("nodos", self.nodes),
            ("aristas", self.edges),
            ("zonas", self.zonas),
        ):
            vistos, repetidos = set(), set()
            for item in items:
                (repetidos if item.id in vistos else vistos).add(item.id)
            if repetidos:
                raise ValueError(f"{nombre} con id repetido: {', '.join(sorted(repetidos))}")
        return self

    @model_validator(mode="after")
    def _referencias_resueltas(self):
        ids_nodo = {n.id for n in self.nodes}
        ids_edificio = {b.id for b in self.buildings}

        colgadas = [
            f"{a.id} ({extremo}={ref})"
            for a in self.edges
            for extremo, ref in (("from", a.desde), ("to", a.hasta))
            if ref not in ids_nodo
        ]
        if colgadas:
            raise ValueError(f"aristas que apuntan a nodos inexistentes: {', '.join(colgadas)}")

        huerfanos = [n.id for n in self.nodes if n.building != EXTERIOR and n.building not in ids_edificio]
        if huerfanos:
            raise ValueError(f"nodos que declaran un edificio inexistente: {', '.join(huerfanos)}")

        zonas_huerfanas = [
            z.id for z in self.zonas
            if z.building not in (None, EXTERIOR) and z.building not in ids_edificio
        ]
        if zonas_huerfanas:
            raise ValueError(f"zonas que declaran un edificio inexistente: {', '.join(zonas_huerfanas)}")
        return self

    @model_validator(mode="after")
    def _sin_aristas_duplicadas(self):
        # El par va sin direccion: mobile.js recorre toda arista en los dos
        # sentidos, asi que (a,b) y (b,a) son la misma arista para el ruteo.
        vistos, repetidos = set(), set()
        for a in self.edges:
            par = frozenset((a.desde, a.hasta))
            (repetidos if par in vistos else vistos).add(par)
        if repetidos:
            detalle = ", ".join(" <-> ".join(sorted(p)) for p in repetidos)
            raise ValueError(f"aristas duplicadas entre los mismos nodos: {detalle}")
        return self


def nodos_fuera_del_area(payload: PublishPayloadIn, lat_sede: float, lng_sede: float) -> list[str]:
    """Nodos que caen fuera del radio de la sede.

    Vive fuera de PublishPayloadIn porque depende de la sede, que el modelo no
    conoce: el router la resuelve y recien ahi puede llamarse.
    """
    grados_lat = RADIO_SEDE_KM / 111.0
    # Un grado de longitud se acorta con la latitud.
    grados_lng = grados_lat / max(cos(radians(lat_sede)), 0.01)
    return [
        n.id
        for n in payload.nodes
        if abs(n.lat - lat_sede) > grados_lat or abs(n.lng - lng_sede) > grados_lng
    ]


# --- Respuesta del publish -------------------------------------------------
#
# La forma es la definitiva, no la que hace falta hoy. Con el Nivel 3 el publish
# va a tener tres desenlaces y no dos: 422, publicado, y borrador no promovido.
# Fijar el contrato ahora evita romper el editor una segunda vez.

class ValidacionOut(BaseModel):
    nivel3_ejecutado: bool = False
    advertencias: list[str] = Field(default_factory=list)


class PublishResultOut(BaseModel):
    version: int
    estado: str = "publicado"
    validacion: ValidacionOut = Field(default_factory=ValidacionOut)
