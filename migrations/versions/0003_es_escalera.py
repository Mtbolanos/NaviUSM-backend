"""es_escalera en arista

Agrega ``arista.es_escalera`` (boolean, default false): marca los tramos de escalera del campus
para poder penalizarlos o excluirlos al calcular rutas accesibles.

Repara una deriva real. La columna aparecio en ``main`` editando ``schema_actualizado.sql`` a mano
(commit 53336b7), sin migracion que la acompanara: el codigo de ``publish_graph_data`` la escribe
(``INSERT INTO arista (..., es_escalera)``) pero una base levantada con ``alembic upgrade head`` no
la tenia, y la publicacion reventaba. Es el mismo problema que la cadena existe para evitar,
ocurriendo una segunda vez.

Va escrita a mano, como el resto: ``migrations/env.py`` aborta cualquier ``--autogenerate`` porque
hay 7 modelos ORM para 14 tablas y comparar contra ellos propondria borrar media base.

Idempotente (``IF NOT EXISTS``), asi que aplica igual sobre una base que venga del dump nuevo
--donde la columna ya existe y no hace nada-- que sobre una anterior.

Revision ID: 0003
Revises: 0002
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = """
ALTER TABLE public.arista ADD COLUMN IF NOT EXISTS es_escalera boolean DEFAULT false;
"""

_DOWNGRADE = """
ALTER TABLE public.arista DROP COLUMN IF EXISTS es_escalera;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Saca la columna. Pierde la marca de escalera de todas las aristas."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
