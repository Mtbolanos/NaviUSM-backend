"""contorno de la sede

Porta a la cadena ``migraciones/005_sede_contorno.sql`` (aplicada a mano en produccion): la
columna opcional ``sede.contorno`` (Polygon 4326). NULL = sin limite.

Idempotente (``IF NOT EXISTS``). En la base de produccion no hace nada.

Revision ID: 0007
Revises: 0006
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0007'
down_revision: Union[str, Sequence[str], None] = '0006'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = """
ALTER TABLE public.sede ADD COLUMN IF NOT EXISTS contorno public.geometry(Polygon, 4326);
"""

_DOWNGRADE = """
ALTER TABLE public.sede DROP COLUMN IF EXISTS contorno;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Saca la columna. Pierde el contorno dibujado de cada sede."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
