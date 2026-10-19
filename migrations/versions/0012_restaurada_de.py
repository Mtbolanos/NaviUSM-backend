"""restaurar: el trigger de snapshot guarda de que version vino una restauracion

``restaurar_version`` (app/grafo/router.py) vuelve a publicar una version guardada como version nueva.
Para que la fila nueva diga de donde vino sin tocar ``publish_graph_data``, la funcion marca su
transaccion con ``SET LOCAL naviusm.restaurada_de = '<n>'`` (via ``set_config(..., true)``) y el trigger
``snapshot_cambios`` lo copia a ``restaurada_de`` al insertar. Queda en la misma transaccion que la
version, y ``SET LOCAL`` muere con ella: una publicacion normal posterior no lo hereda.

Reemplaza solo ``snapshot_calcular_cambios()``; el resto de la 0010 queda igual. El downgrade
reinstala el cuerpo de la 0010 (con el resguardo de 62482f8).

Revision ID: 0012
Revises: 0011
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0012'
down_revision: Union[str, Sequence[str], None] = '0011'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = r"""
CREATE OR REPLACE FUNCTION public.snapshot_calcular_cambios() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    previo record;
    origen text;
BEGIN
    -- Restaurar (0012): restaurar_version marca su transaccion con SET LOCAL naviusm.restaurada_de.
    -- Fuera de esa transaccion el valor vuelve a ser vacio. Un valor no numerico se ignora.
    IF NEW.restaurada_de IS NULL THEN
        origen := current_setting('naviusm.restaurada_de', true);
        IF origen ~ '^[0-9]+$' THEN
            NEW.restaurada_de := origen::integer;
        END IF;
    END IF;
    IF NEW.cambios IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT version, payload INTO previo
    FROM public.snapshot
    WHERE sede_id = NEW.sede_id AND version < NEW.version
    ORDER BY version DESC
    LIMIT 1;
    IF FOUND THEN
        BEGIN
            NEW.cambios := jsonb_build_object('desde', previo.version, 'hasta', NEW.version)
                           || coalesce(public.diferencias_grafo(previo.payload, NEW.payload), '{}'::jsonb);
        EXCEPTION WHEN OTHERS THEN
            -- El historial nunca frena una publicacion: sin comparacion, la version entra con cambios NULL.
            -- (sin marcadores con porcentaje: psycopg2 los tomaria como parametros al migrar)
            RAISE WARNING USING MESSAGE = 'snapshot_cambios: no se pudo comparar sede ' || NEW.sede_id
                || ' v' || NEW.version || ' con v' || previo.version || ': ' || SQLERRM;
            NEW.cambios := NULL;
        END;
    END IF;
    RETURN NEW;
END
$$;

COMMENT ON COLUMN public.snapshot.restaurada_de IS 'Version de origen si esta version vino de restaurar una anterior; la escribe el trigger snapshot_cambios desde SET LOCAL naviusm.restaurada_de (migracion 0012). NULL si no.';
"""

_DOWNGRADE = r"""
CREATE OR REPLACE FUNCTION public.snapshot_calcular_cambios() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    previo record;
BEGIN
    IF NEW.cambios IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT version, payload INTO previo
    FROM public.snapshot
    WHERE sede_id = NEW.sede_id AND version < NEW.version
    ORDER BY version DESC
    LIMIT 1;
    IF FOUND THEN
        BEGIN
            NEW.cambios := jsonb_build_object('desde', previo.version, 'hasta', NEW.version)
                           || coalesce(public.diferencias_grafo(previo.payload, NEW.payload), '{}'::jsonb);
        EXCEPTION WHEN OTHERS THEN
            -- El historial nunca frena una publicacion: sin comparacion, la version entra con cambios NULL.
            -- (sin marcadores con porcentaje: psycopg2 los tomaria como parametros al migrar)
            RAISE WARNING USING MESSAGE = 'snapshot_cambios: no se pudo comparar sede ' || NEW.sede_id
                || ' v' || NEW.version || ' con v' || previo.version || ': ' || SQLERRM;
            NEW.cambios := NULL;
        END;
    END IF;
    RETURN NEW;
END
$$;

COMMENT ON COLUMN public.snapshot.restaurada_de IS 'Version de origen si esta version vino de restaurar una anterior; NULL si no.';
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Vuelve al trigger de la 0010: restaurada_de deja de llenarse sola."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
