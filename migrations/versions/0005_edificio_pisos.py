"""pisos de edificio: edificio_piso y edificio.piso_acceso

Porta a la cadena la parte de esquema de ``migraciones/003_edificio_pisos.sql`` (aplicada a mano
en produccion): la tabla ``edificio_piso`` (un registro por piso, con nombre opcional), la columna
``edificio.piso_acceso`` y la migracion de datos del rango ``piso_min``/``piso_max`` a filas de
``edificio_piso``, despues de la cual esas dos columnas se borran.

El ``DROP TABLE sala`` que ese mismo .sql hace al final va en su propia revision (0008), porque es
un cambio logico distinto.

Idempotente, igual que el .sql original: ``IF NOT EXISTS`` en la tabla y la columna, y la
conversion solo corre si ``piso_min`` todavia existe. En la base de produccion no hace nada.

Revision ID: 0005
Revises: 0004
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = """
CREATE TABLE IF NOT EXISTS public.edificio_piso (
    edificio_id uuid NOT NULL REFERENCES public.edificio(id) ON DELETE CASCADE,
    organizacion_id uuid NOT NULL REFERENCES public.organizacion(id) ON DELETE CASCADE,
    numero integer NOT NULL,
    nombre character varying(100),
    PRIMARY KEY (edificio_id, numero)
);

ALTER TABLE public.edificio_piso ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.edificio ADD COLUMN IF NOT EXISTS piso_acceso integer DEFAULT 1 NOT NULL;

-- Pasar el rango piso_min..piso_max a filas de edificio_piso (solo si las columnas antiguas siguen existiendo)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'edificio' AND column_name = 'piso_min'
    ) THEN
        INSERT INTO public.edificio_piso (edificio_id, organizacion_id, numero)
        SELECT e.id, e.organizacion_id, g.numero
        FROM public.edificio e,
             generate_series(LEAST(e.piso_min, e.piso_max), GREATEST(e.piso_min, e.piso_max)) AS g(numero)
        ON CONFLICT DO NOTHING;

        -- El acceso es el piso 1 (nivel de calle) si el edificio lo tiene; si no, su piso mas bajo
        UPDATE public.edificio
        SET piso_acceso = CASE
            WHEN 1 BETWEEN LEAST(piso_min, piso_max) AND GREATEST(piso_min, piso_max) THEN 1
            ELSE LEAST(piso_min, piso_max)
        END;

        ALTER TABLE public.edificio DROP COLUMN piso_min, DROP COLUMN piso_max;
    END IF;
END $$;

-- Todo edificio debe tener al menos su piso de acceso
INSERT INTO public.edificio_piso (edificio_id, organizacion_id, numero)
SELECT e.id, e.organizacion_id, e.piso_acceso
FROM public.edificio e
WHERE NOT EXISTS (SELECT 1 FROM public.edificio_piso p WHERE p.edificio_id = e.id);
"""

# Vuelve al rango: piso_min/piso_max = menor/mayor piso registrado (1 si el edificio no tiene
# pisos). Es con perdida: se pierden los nombres de piso, los huecos de la lista y piso_acceso.
_DOWNGRADE = """
ALTER TABLE public.edificio ADD COLUMN IF NOT EXISTS piso_min integer DEFAULT 1 NOT NULL;
ALTER TABLE public.edificio ADD COLUMN IF NOT EXISTS piso_max integer DEFAULT 1 NOT NULL;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'edificio_piso'
    ) THEN
        UPDATE public.edificio e
        SET piso_min = r.minimo, piso_max = r.maximo
        FROM (
            SELECT edificio_id, MIN(numero) AS minimo, MAX(numero) AS maximo
            FROM public.edificio_piso GROUP BY edificio_id
        ) r
        WHERE r.edificio_id = e.id;
    END IF;
END $$;

ALTER TABLE public.edificio DROP COLUMN IF EXISTS piso_acceso;
DROP TABLE IF EXISTS public.edificio_piso;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Vuelve al rango piso_min/piso_max. Con perdida: nombres de piso, huecos y piso_acceso."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
