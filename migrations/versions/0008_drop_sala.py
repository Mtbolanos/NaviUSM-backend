"""elimina la tabla sala

Porta a la cadena el ``DROP TABLE IF EXISTS public.sala`` con que cierra
``migraciones/003_edificio_pisos.sql`` (aplicado a mano en produccion). ``sala`` era redundante con
``poi``: las salas se modelan como nodos "Entrada / Sala" del mapa.

La 0002 sigue creando ``sala`` (no se reescribe una revision ya citada); esta la borra, asi que
``upgrade head`` termina sin ella en cualquier punto de partida.

Idempotente (``IF EXISTS``).

Revision ID: 0008
Revises: 0007
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0008'
down_revision: Union[str, Sequence[str], None] = '0007'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = """
DROP TABLE IF EXISTS public.sala;
"""

# Recrea la tabla vacia, con la misma definicion que le da la 0002.
_DOWNGRADE = """
CREATE TABLE IF NOT EXISTS public.sala (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    edificio_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    piso integer NOT NULL,
    nombre character varying(255) NOT NULL
);

DO $$ BEGIN
    ALTER TABLE ONLY public.sala ADD CONSTRAINT sala_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.sala
        ADD CONSTRAINT sala_edificio_id_fkey FOREIGN KEY (edificio_id) REFERENCES public.edificio(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.sala
        ADD CONSTRAINT sala_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_sala_edificio_piso ON public.sala USING btree (edificio_id, piso);

ALTER TABLE public.sala ENABLE ROW LEVEL SECURITY;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Recrea la tabla vacia. Sus filas no se recuperan (y nunca hubo uso de la tabla)."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
