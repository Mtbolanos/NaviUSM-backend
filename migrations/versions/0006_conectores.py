"""conectores verticales: conector y nodo.conector_id

Porta a la cadena ``migraciones/004_conectores.sql`` (aplicada a mano en produccion): la tabla
``conector`` (escalera, ascensor o rampa de un edificio), su indice y RLS, y la columna
``nodo.conector_id`` que agrupa las paradas de un conector, con su indice.

Idempotente (``IF NOT EXISTS``), como el .sql original. En la base de produccion no hace nada.

Revision ID: 0006
Revises: 0005
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0006'
down_revision: Union[str, Sequence[str], None] = '0005'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = """
CREATE TABLE IF NOT EXISTS public.conector (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    sede_id uuid NOT NULL REFERENCES public.sede(id) ON DELETE CASCADE,
    edificio_id uuid NOT NULL REFERENCES public.edificio(id) ON DELETE CASCADE,
    organizacion_id uuid NOT NULL REFERENCES public.organizacion(id) ON DELETE CASCADE,
    tipo character varying(20) NOT NULL CHECK (tipo IN ('escalera', 'ascensor', 'rampa')),
    nombre character varying(255)
);

CREATE INDEX IF NOT EXISTS idx_conector_edificio ON public.conector USING btree (edificio_id);

ALTER TABLE public.conector ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.nodo ADD COLUMN IF NOT EXISTS conector_id uuid REFERENCES public.conector(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_nodo_conector ON public.nodo USING btree (conector_id);
"""

_DOWNGRADE = """
DROP INDEX IF EXISTS public.idx_nodo_conector;
ALTER TABLE public.nodo DROP COLUMN IF EXISTS conector_id;
DROP TABLE IF EXISTS public.conector;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Borra la columna y la tabla. Las paradas quedan como nodos sueltos, sin conector."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
