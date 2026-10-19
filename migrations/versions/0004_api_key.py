"""api_key

Crea la tabla ``api_key`` (llaves de la app movil por organizacion) y su indice.

Porta a la cadena un cambio que se aplico por fuera de Alembic. ``schema_actualizado.sql`` (1.3.1)
la trae en su bloque final citando ``migraciones/002_api_keys.sql``, pero ese archivo no existe en
el repo: el DDL de aca se reconstruyo desde el bloque del dump, tal cual (mismos tipos, defaults,
PK/UNIQUE/FK en linea, sin RLS, igual que en el dump).

Idempotente (``IF NOT EXISTS``): en la base de produccion, que ya tiene la tabla, no hace nada.

Revision ID: 0004
Revises: 0003
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = """
CREATE TABLE IF NOT EXISTS public.api_key (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    organizacion_id uuid NOT NULL REFERENCES public.organizacion(id) ON DELETE CASCADE,
    nombre character varying(255) NOT NULL,
    prefijo character varying(16) NOT NULL,
    key_hash character varying(64) NOT NULL UNIQUE,
    created_by uuid REFERENCES public.usuario(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    last_used_at timestamp with time zone,
    revoked_at timestamp with time zone
);

CREATE INDEX IF NOT EXISTS idx_api_key_organizacion ON public.api_key USING btree (organizacion_id);
"""

_DOWNGRADE = """
DROP TABLE IF EXISTS public.api_key;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Borra la tabla. Revoca de hecho todas las llaves emitidas (la app movil deja de autenticar)."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
