"""Nivel 3: integridad topologica del grafo peatonal.

Los Niveles 1 y 2 miran filas: que cada nodo y cada arista esten bien formados.
Este nivel mira el grafo completo, que es lo unico que detecta un campus partido
en dos aunque cada fila sea valida.

Corre ANTES de escribir (decision 0003, opcion B «publicar = promover»): el
router lo llama antes de publish_graph_data y, si hay un defecto de conectividad,
no publica (422 `bloqueado`) salvo que el admin fuerce con un motivo. La
accesibilidad no bloquea nunca: es un hallazgo sobre el campus, no un defecto del
dato, y se informa como advertencia. Es una funcion pura sobre el payload (dict)
y no lo modifica, asi que no puede alterar el artefacto que se publica.

Que bloquea (`ReporteTopologia.bloquea_publicacion`): mas de una componente, algun
nodo aislado o pares de POIs sin ruta. Si el grafo tiene menos de 2 POIs no hay
alcanzabilidad que medir (alcanzabilidad_pct es None) y no se bloquea: se informa
lo que haya como advertencia. Tampoco se bloquea si el validador falla: se publica
con nivel3_ejecutado=false (ver `revisar_topologia`).

Convenciones que hay que declarar:

* El grafo se trata como no dirigido: se consume bidireccional
  (ver `_sin_aristas_duplicadas` en app/grafo/schemas.py).
* Un POI es un nodo cuyo tipo genera fila en `poi` (todo menos TIPOS_SIN_POI),
  la misma definicion que usa el pipeline de publicacion.
* "Accesible" significa "sin escaleras". Es la unica senal de accesibilidad que
  viaja en el payload: el esquema tiene `arista.es_accesible`
  (schema_actualizado.sql:48), pero ni el editor la manda (static/js/admin.js:167)
  ni el pipeline la escribe. Cuando exista, se cambia `_es_accesible` y nada mas.
"""
import logging
from dataclasses import dataclass, field
from typing import Any

from app.grafo.schemas import TIPOS_SIN_POI, ValidacionOut

logger = logging.getLogger(__name__)

# Cuantos ids se nombran en un mensaje antes de resumir con "y N mas".
_MAX_IDS_EN_MENSAJE = 5


def _es_accesible(arista: dict[str, Any]) -> bool:
    return not arista.get("es_escalera", False)


class _UnionFind:
    def __init__(self, elementos):
        self._padre = {e: e for e in elementos}

    def raiz(self, x):
        while self._padre[x] != x:
            self._padre[x] = self._padre[self._padre[x]]
            x = self._padre[x]
        return x

    def unir(self, a, b):
        ra, rb = self.raiz(a), self.raiz(b)
        if ra != rb:
            self._padre[ra] = rb


def _pares(n: int) -> int:
    return n * (n - 1) // 2


def _componentes(ids_nodo, aristas) -> _UnionFind:
    uf = _UnionFind(ids_nodo)
    for a in aristas:
        uf.unir(a["from"], a["to"])
    return uf


def _pares_con_ruta(uf: _UnionFind, ids_poi) -> int:
    """Pares de POIs que caen en la misma componente.

    Se cuenta por componente (suma de C(k, 2)) y no par por par: es lineal y da
    el mismo numero.
    """
    por_componente: dict[Any, int] = {}
    for p in ids_poi:
        r = uf.raiz(p)
        por_componente[r] = por_componente.get(r, 0) + 1
    return sum(_pares(k) for k in por_componente.values())


def _porcentaje(parte: int, total: int) -> float | None:
    return None if total == 0 else round(100 * parte / total, 2)


def _nombrar(ids: list[str]) -> str:
    visibles = ", ".join(ids[:_MAX_IDS_EN_MENSAJE])
    resto = len(ids) - _MAX_IDS_EN_MENSAJE
    return visibles if resto <= 0 else f"{visibles} y {resto} mas"


@dataclass
class ReporteTopologia:
    nodos: int
    aristas: int
    pois: int
    componentes: int
    nodos_aislados: list[str]
    pares_poi: int
    pares_con_ruta: int
    componentes_accesibles: int
    pares_con_ruta_accesible: int
    aristas_colgantes: list[str] = field(default_factory=list)
    # id -> nombre legible, solo para que los avisos no sean una lista de UUIDs.
    rotulos: dict[str, str] = field(default_factory=dict)

    @property
    def alcanzabilidad_pct(self) -> float | None:
        return _porcentaje(self.pares_con_ruta, self.pares_poi)

    @property
    def alcanzabilidad_accesible_pct(self) -> float | None:
        return _porcentaje(self.pares_con_ruta_accesible, self.pares_poi)

    @property
    def conectividad_integra(self) -> bool:
        return self.componentes <= 1 and not self.nodos_aislados and self.pares_con_ruta == self.pares_poi

    @property
    def bloquea_publicacion(self) -> bool:
        """Defecto de conectividad que impide promover (decision 0003).

        Con menos de 2 POIs (pares_poi == 0) no hay alcanzabilidad que evaluar y no se bloquea:
        lo conservador es no frenar lo que el criterio no puede medir. Las escaleras no cuentan.
        """
        return self.pares_poi > 0 and not self.conectividad_integra

    def motivo_bloqueo(self) -> str:
        """Resumen legible del bloqueo, para el `detail` del 422. Sin punto final: el editor lo
        agrega (static/js/admin.js:3611)."""
        partes = []
        if self.componentes > 1:
            partes.append(f"el grafo está partido en {self.componentes} componentes")
        if self.nodos_aislados:
            rotulados = [self.rotulos.get(i, i) for i in self.nodos_aislados]
            n = len(rotulados)
            partes.append(f"{n} {'nodo' if n == 1 else 'nodos'} sin aristas: {_nombrar(rotulados)}")
        sin_ruta = self.pares_poi - self.pares_con_ruta
        if sin_ruta:
            partes.append(f"{sin_ruta} de {self.pares_poi} pares de POIs sin ruta entre sí")
        return "Publicación bloqueada por integridad topológica: " + "; ".join(partes)

    def advertencias(self) -> list[str]:
        """Los hallazgos en lenguaje del editor. Vacio si el grafo esta sano."""
        avisos = []
        if self.aristas_colgantes:
            avisos.append(
                f"aristas que apuntan a nodos que no existen (se ignoraron): {_nombrar(self.aristas_colgantes)}"
            )
        if self.componentes > 1:
            avisos.append(f"el grafo esta partido en {self.componentes} componentes conexas (deberia ser 1)")
        if self.nodos_aislados:
            rotulados = [self.rotulos.get(i, i) for i in self.nodos_aislados]
            avisos.append(f"{len(rotulados)} nodo(s) sin ninguna arista: {_nombrar(rotulados)}")
        sin_ruta = self.pares_poi - self.pares_con_ruta
        if sin_ruta:
            avisos.append(
                f"{sin_ruta} de {self.pares_poi} pares de POIs no tienen ruta entre si ({self.alcanzabilidad_pct}% alcanzable)"
            )
        # Solo se avisa lo que las escaleras agregan: lo que ya no tenia ruta
        # sin importar el tipo de arista quedo dicho arriba.
        sin_ruta_accesible = self.pares_poi - self.pares_con_ruta_accesible
        if sin_ruta_accesible > sin_ruta:
            avisos.append(
                f"sin usar escaleras, {sin_ruta_accesible - sin_ruta} pares de POIs mas quedan sin ruta "
                f"({self.alcanzabilidad_accesible_pct}% alcanzable en silla de ruedas)"
            )
        return avisos

    def como_dict(self) -> dict[str, Any]:
        return {
            "nodos": self.nodos,
            "aristas": self.aristas,
            "pois": self.pois,
            "componentes": self.componentes,
            "nodos_aislados": len(self.nodos_aislados),
            "pares_poi": self.pares_poi,
            "alcanzabilidad_pct": self.alcanzabilidad_pct,
            "componentes_accesibles": self.componentes_accesibles,
            "alcanzabilidad_accesible_pct": self.alcanzabilidad_accesible_pct,
        }


def evaluar_topologia(payload: dict[str, Any]) -> ReporteTopologia:
    """Mide la integridad topologica de un payload de publicacion.

    Acepta el dict tal como lo manda el editor o como lo sirve el snapshot
    publico, y no lo modifica.
    """
    nodos = payload.get("nodes", [])
    ids_nodo = [n["id"] for n in nodos]
    existentes = set(ids_nodo)

    colgantes = []
    aristas = []
    for a in payload.get("edges", []):
        if a["from"] in existentes and a["to"] in existentes:
            aristas.append(a)
        else:
            colgantes.append(a["id"])

    con_arista = {extremo for a in aristas for extremo in (a["from"], a["to"])}
    ids_poi = [n["id"] for n in nodos if n["type"] not in TIPOS_SIN_POI]

    uf = _componentes(ids_nodo, aristas)
    uf_accesible = _componentes(ids_nodo, [a for a in aristas if _es_accesible(a)])

    return ReporteTopologia(
        nodos=len(ids_nodo),
        aristas=len(aristas),
        pois=len(ids_poi),
        componentes=len({uf.raiz(i) for i in ids_nodo}),
        nodos_aislados=[i for i in ids_nodo if i not in con_arista],
        pares_poi=_pares(len(ids_poi)),
        pares_con_ruta=_pares_con_ruta(uf, ids_poi),
        componentes_accesibles=len({uf_accesible.raiz(i) for i in ids_nodo}),
        pares_con_ruta_accesible=_pares_con_ruta(uf_accesible, ids_poi),
        aristas_colgantes=colgantes,
        rotulos={n["id"]: n["name"] for n in nodos if (n.get("name") or "").strip()},
    )


@dataclass
class RevisionNivel3:
    """Lo que el publish necesita del Nivel 3: el bloque `validacion` de la respuesta y, si el
    validador corrio, el reporte (para decidir el bloqueo y armar el motivo)."""
    validacion: ValidacionOut
    reporte: ReporteTopologia | None = None

    @property
    def bloquea(self) -> bool:
        return self.reporte is not None and self.reporte.bloquea_publicacion


def revisar_topologia(payload: dict[str, Any]) -> RevisionNivel3:
    """Punto de entrada del publish, antes de escribir. No lanza.

    Si el validador falla, se publica igual con nivel3_ejecutado=false (falla abierta): un error
    del validador no es evidencia de un defecto del grafo, y bloquear por eso dejaria sin poder
    publicar por un bug propio. Queda en el log y en la fila de `publicacion`.
    """
    try:
        reporte = evaluar_topologia(payload)
        return RevisionNivel3(ValidacionOut(nivel3_ejecutado=True, advertencias=reporte.advertencias()), reporte)
    except Exception:
        logger.exception("el validador topologico fallo; se publica sin reporte")
        return RevisionNivel3(ValidacionOut(nivel3_ejecutado=False))
