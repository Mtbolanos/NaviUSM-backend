"""cada snapshot guarda que cambio respecto a la version anterior

Agrega a ``snapshot`` dos columnas y deja en la base la comparacion entre versiones:

- ``cambios`` (jsonb): que se agrego, borro o modifico respecto a la version anterior de la sede.
  Lo llena el trigger ``snapshot_cambios`` en el mismo INSERT, asi que queda en la misma
  transaccion que la version: no hay version sin sus cambios ni cambios sin su version. NULL solo
  en la primera version de una sede (no hay con que comparar). Si la version es identica a la
  anterior queda ``{"desde": n-1, "hasta": n}`` sin colecciones.
- ``restaurada_de`` (integer): la version de origen si esta version vino de restaurar una anterior.

``diferencias_grafo(anterior, nuevo)`` compara dos payloads de publicacion:

- Toda clave cuyo valor es una lista de objetos es una coleccion (nodes, edges, buildings,
  zonas, conectores, y cualquiera que el editor agregue). Sus elementos se emparejan por ``id``:
  agregados, borrados y modificados (con los nombres de los campos que difieren). El orden de la
  lista no importa y ``8`` contra ``8.0`` tampoco: la igualdad de jsonb compara numeros por valor.
- Una coleccion con elementos sin ``id`` o con ids repetidos no se puede emparejar: si difiere, se
  informa ``{"id": null, "campos": ["*"]}`` (nunca «sin cambios» por error).
- Un objeto en la raiz (``meta``) informa los campos que difieren; cualquier otro valor de la raiz
  que cambie va en ``_raiz``.
- Devuelve NULL si no hay ninguna diferencia, o si alguno de los dos no es un objeto JSON.
  Solo trae las colecciones que cambiaron.

El router la usa tambien para decidir ``sin_cambios`` antes de publicar, asi que la regla de que
cuenta como cambio vive en un solo lugar.

Idempotente: ``ADD COLUMN IF NOT EXISTS``, ``CREATE OR REPLACE`` y ``DROP TRIGGER IF EXISTS`` antes
de crearlo.

Revision ID: 0010
Revises: 0009
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0010'
down_revision: Union[str, Sequence[str], None] = '0009'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = r"""
ALTER TABLE public.snapshot
    ADD COLUMN IF NOT EXISTS cambios jsonb,
    ADD COLUMN IF NOT EXISTS restaurada_de integer;

COMMENT ON COLUMN public.snapshot.cambios IS 'Diferencia con la version anterior de la sede (diferencias_grafo). La llena el trigger snapshot_cambios. NULL solo en la primera version.';
COMMENT ON COLUMN public.snapshot.restaurada_de IS 'Version de origen si esta version vino de restaurar una anterior; NULL si no.';

CREATE OR REPLACE FUNCTION public.diferencias_grafo(anterior jsonb, nuevo jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    resultado jsonb := '{}'::jsonb;
    raiz jsonb := '[]'::jsonb;
    clave text;
    a jsonb;
    b jsonb;
    agregados jsonb;
    borrados jsonb;
    modificados jsonb;
    emparejables boolean;
BEGIN
    IF anterior IS NULL OR nuevo IS NULL
       OR jsonb_typeof(anterior) <> 'object' OR jsonb_typeof(nuevo) <> 'object' THEN
        RETURN NULL;
    END IF;
    IF anterior = nuevo THEN
        RETURN NULL;
    END IF;

    FOR clave IN
        SELECT k FROM (SELECT jsonb_object_keys(anterior) AS k UNION SELECT jsonb_object_keys(nuevo)) t ORDER BY k
    LOOP
        a := anterior -> clave;
        b := nuevo -> clave;
        CONTINUE WHEN a IS NOT DISTINCT FROM b;

        IF (a IS NULL OR jsonb_typeof(a) = 'array') AND (b IS NULL OR jsonb_typeof(b) = 'array')
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(a, '[]') || coalesce(b, '[]')) e
                           WHERE jsonb_typeof(e) <> 'object') THEN
            -- coleccion: emparejar por id
            a := coalesce(a, '[]');
            b := coalesce(b, '[]');
            SELECT bool_and(ok) INTO emparejables FROM (
                SELECT count(*) = count(DISTINCT e ->> 'id')
                       AND bool_and(jsonb_typeof(e -> 'id') IN ('string', 'number')) AS ok
                FROM jsonb_array_elements(a) e
                UNION ALL
                SELECT count(*) = count(DISTINCT e ->> 'id')
                       AND bool_and(jsonb_typeof(e -> 'id') IN ('string', 'number'))
                FROM jsonb_array_elements(b) e
            ) t;

            IF NOT coalesce(emparejables, true) THEN
                resultado := resultado || jsonb_build_object(clave, jsonb_build_object(
                    'agregados', '[]'::jsonb, 'borrados', '[]'::jsonb,
                    'modificados', jsonb_build_array(jsonb_build_object('id', NULL, 'campos', jsonb_build_array('*')))));
                CONTINUE;
            END IF;

            SELECT coalesce(jsonb_agg(id ORDER BY id), '[]') INTO agregados FROM (
                SELECT e ->> 'id' AS id FROM jsonb_array_elements(b) e
                EXCEPT SELECT e ->> 'id' FROM jsonb_array_elements(a) e) t;
            SELECT coalesce(jsonb_agg(id ORDER BY id), '[]') INTO borrados FROM (
                SELECT e ->> 'id' AS id FROM jsonb_array_elements(a) e
                EXCEPT SELECT e ->> 'id' FROM jsonb_array_elements(b) e) t;
            SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'campos', campos) ORDER BY id), '[]') INTO modificados FROM (
                SELECT ea ->> 'id' AS id,
                       (SELECT jsonb_agg(k ORDER BY k) FROM (
                            SELECT jsonb_object_keys(ea) AS k UNION SELECT jsonb_object_keys(eb)) kk
                        WHERE ea -> k IS DISTINCT FROM eb -> k) AS campos
                FROM jsonb_array_elements(a) ea
                JOIN jsonb_array_elements(b) eb ON ea ->> 'id' = eb ->> 'id'
                WHERE ea <> eb) t;

            IF agregados <> '[]' OR borrados <> '[]' OR modificados <> '[]' THEN
                resultado := resultado || jsonb_build_object(clave, jsonb_build_object(
                    'agregados', agregados, 'borrados', borrados, 'modificados', modificados));
            END IF;

        ELSIF jsonb_typeof(a) = 'object' AND jsonb_typeof(b) = 'object' THEN
            -- objeto de la raiz (meta): que campos difieren
            resultado := resultado || jsonb_build_object(clave, jsonb_build_object('campos', (
                SELECT jsonb_agg(k ORDER BY k) FROM (
                    SELECT jsonb_object_keys(a) AS k UNION SELECT jsonb_object_keys(b)) kk
                WHERE a -> k IS DISTINCT FROM b -> k)));

        ELSE
            raiz := raiz || to_jsonb(clave);
        END IF;
    END LOOP;

    IF raiz <> '[]' THEN
        resultado := resultado || jsonb_build_object('_raiz', jsonb_build_object('campos', raiz));
    END IF;
    IF resultado = '{}' THEN
        RETURN NULL;
    END IF;
    RETURN resultado;
END
$$;

COMMENT ON FUNCTION public.diferencias_grafo(jsonb, jsonb) IS 'Que cambio entre dos payloads de publicacion del grafo, emparejando por id. NULL si son iguales. Ver migracion 0010.';

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
        NEW.cambios := jsonb_build_object('desde', previo.version, 'hasta', NEW.version)
                       || coalesce(public.diferencias_grafo(previo.payload, NEW.payload), '{}'::jsonb);
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS snapshot_cambios ON public.snapshot;
CREATE TRIGGER snapshot_cambios BEFORE INSERT ON public.snapshot
    FOR EACH ROW EXECUTE FUNCTION public.snapshot_calcular_cambios();
"""

_DOWNGRADE = """
DROP TRIGGER IF EXISTS snapshot_cambios ON public.snapshot;
DROP FUNCTION IF EXISTS public.snapshot_calcular_cambios();
DROP FUNCTION IF EXISTS public.diferencias_grafo(jsonb, jsonb);
ALTER TABLE public.snapshot
    DROP COLUMN IF EXISTS restaurada_de,
    DROP COLUMN IF EXISTS cambios;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Quita el trigger, las funciones y las columnas. Se pierden los cambios ya calculados."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
