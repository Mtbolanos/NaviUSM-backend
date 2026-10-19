"""reglas del Nivel 1 que faltaban: el esquema rechaza grafos mal formados aunque no pasen por la API

Cinco restricciones que la inyeccion de fallas encontro sin detector (la falla entraba):

- ``chk_arista_distancia_positiva``: ``distancia > 0``.
- ``excl_arista_par_unico``: una sola arista por par de nodos, en cualquier direccion
  (A-B y B-A son la misma, porque el grafo se consume bidireccional).
- ``excl_nodo_coordenada_piso``: dos nodos de la misma sede no pueden estar en la misma coordenada y
  el mismo piso. En pisos distintos si (los conectores verticales repiten lat/lng).
- ``chk_nodo_coordenadas_rango``: longitud entre -180 y 180, latitud entre -90 y 90.
- ``chk_zona_geometria_valida``: ``ST_IsValid(geom)`` (sin poligonos que se cruzan ni anillos con
  puntos insuficientes).

Las dos de unicidad son ``EXCLUDE ... DEFERRABLE INITIALLY DEFERRED``: ``publish_graph_data`` primero
hace upsert de lo que llega y despues borra lo que no vino, asi que reemplazar una arista por otra
con id nuevo sobre el mismo par, o mover un nodo a la coordenada de uno que se borra, deja un
duplicado pasajero dentro de la transaccion. Diferidas, se revisan en el COMMIT. Se usa EXCLUDE y
no un indice unico porque un indice sobre expresiones no puede ser diferible.

Antes de crear cada una, ``upgrade`` busca las filas que la violarian y, si hay, falla con un mensaje
que las lista. No corrige nada sola: decidir que fila o que geometria se arregla es humano. (Al
2026-10-19, 3 de los 4 contornos de edificio de Casa Central son invalidos y hay que redibujarlos
antes de aplicar esta migracion en produccion.)

Idempotente: cada restriccion se crea solo si no existe.

Revision ID: 0011
Revises: 0010
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0011'
down_revision: Union[str, Sequence[str], None] = '0010'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Filas que violarian cada regla; si alguna consulta devuelve algo, la migracion no sigue.
_PRECHEQUEO = {
    "chk_arista_distancia_positiva":
        "SELECT id::text FROM public.arista WHERE distancia <= 0 ORDER BY 1 LIMIT 20",
    "excl_arista_par_unico":
        "SELECT LEAST(origen_id, destino_id) || '-' || GREATEST(origen_id, destino_id) || ' (x' || count(*) || ')' "
        "FROM public.arista GROUP BY LEAST(origen_id, destino_id), GREATEST(origen_id, destino_id) "
        "HAVING count(*) > 1 ORDER BY 1 LIMIT 20",
    "excl_nodo_coordenada_piso":
        "SELECT string_agg(id::text, ',' ORDER BY id) FROM public.nodo "
        "GROUP BY sede_id, piso, ST_X(geom), ST_Y(geom) HAVING count(*) > 1 ORDER BY 1 LIMIT 20",
    "chk_nodo_coordenadas_rango":
        "SELECT id::text FROM public.nodo "
        "WHERE NOT (ST_X(geom) BETWEEN -180 AND 180 AND ST_Y(geom) BETWEEN -90 AND 90) ORDER BY 1 LIMIT 20",
    "chk_zona_geometria_valida":
        "SELECT id::text || ' ' || coalesce(nombre, '') FROM public.zona WHERE NOT ST_IsValid(geom) ORDER BY 1 LIMIT 20",
}

_UPGRADE = """
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arista_distancia_positiva') THEN
        ALTER TABLE public.arista ADD CONSTRAINT chk_arista_distancia_positiva CHECK (distancia > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'excl_arista_par_unico') THEN
        ALTER TABLE public.arista ADD CONSTRAINT excl_arista_par_unico
            EXCLUDE USING btree ((LEAST(origen_id, destino_id)) WITH =, (GREATEST(origen_id, destino_id)) WITH =)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'excl_nodo_coordenada_piso') THEN
        ALTER TABLE public.nodo ADD CONSTRAINT excl_nodo_coordenada_piso
            EXCLUDE USING btree (sede_id WITH =, piso WITH =, (public.ST_X(geom)) WITH =, (public.ST_Y(geom)) WITH =)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_nodo_coordenadas_rango') THEN
        ALTER TABLE public.nodo ADD CONSTRAINT chk_nodo_coordenadas_rango
            CHECK (public.ST_X(geom) BETWEEN -180 AND 180 AND public.ST_Y(geom) BETWEEN -90 AND 90);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_zona_geometria_valida') THEN
        ALTER TABLE public.zona ADD CONSTRAINT chk_zona_geometria_valida CHECK (public.ST_IsValid(geom));
    END IF;
END $$;

COMMENT ON CONSTRAINT chk_arista_distancia_positiva ON public.arista IS 'Nivel 1: la distancia de una arista es mayor que 0.';
COMMENT ON CONSTRAINT excl_arista_par_unico ON public.arista IS 'Nivel 1: una sola arista por par de nodos, en cualquier direccion. Diferida: se revisa en el COMMIT.';
COMMENT ON CONSTRAINT excl_nodo_coordenada_piso ON public.nodo IS 'Nivel 1: un solo nodo por coordenada y piso en cada sede. Diferida: se revisa en el COMMIT.';
COMMENT ON CONSTRAINT chk_nodo_coordenadas_rango ON public.nodo IS 'Nivel 1: longitud entre -180 y 180, latitud entre -90 y 90.';
COMMENT ON CONSTRAINT chk_zona_geometria_valida ON public.zona IS 'Nivel 1: la geometria de la zona es valida (ST_IsValid).';
"""

_DOWNGRADE = """
ALTER TABLE public.zona DROP CONSTRAINT IF EXISTS chk_zona_geometria_valida;
ALTER TABLE public.nodo DROP CONSTRAINT IF EXISTS chk_nodo_coordenadas_rango;
ALTER TABLE public.nodo DROP CONSTRAINT IF EXISTS excl_nodo_coordenada_piso;
ALTER TABLE public.arista DROP CONSTRAINT IF EXISTS excl_arista_par_unico;
ALTER TABLE public.arista DROP CONSTRAINT IF EXISTS chk_arista_distancia_positiva;
"""


def upgrade() -> None:
    bind = op.get_bind()
    violaciones = {}
    for regla, consulta in _PRECHEQUEO.items():
        filas = [f[0] for f in bind.exec_driver_sql(consulta).fetchall()]
        if filas:
            violaciones[regla] = filas
    if violaciones:
        detalle = "; ".join(f"{regla}: {', '.join(filas)}" for regla, filas in violaciones.items())
        raise RuntimeError(
            "0011: hay datos que violan las reglas del Nivel 1. Corregirlos antes de migrar "
            f"(la migracion no los toca): {detalle}"
        )
    bind.exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Quita las cinco restricciones. Los datos no se tocan."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
