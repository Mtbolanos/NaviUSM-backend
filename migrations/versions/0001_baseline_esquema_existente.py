"""baseline esquema existente

Punto de partida del historial. NO crea nada: representa el esquema base de 10 tablas
(organizacion, usuario, sede, snapshot, edificio, nodo, arista, poi, ruta_evacuacion,
ruta_evacuacion_arista) tal como lo deja ``schema_actualizado.sql``.

Por que es un no-op en vez de re-declarar el esquema:

- El esquema base ya existe en las bases en uso, y en una base nueva lo crea
  ``docker/init/01-init.sh`` aplicando el dump antes de que Alembic entre en escena.
- Re-declarar 822 lineas de dump como codigo de migracion solo introduciria una segunda
  definicion del mismo esquema, que se puede desincronizar de la primera.

Consecuencia practica: ``alembic upgrade head`` funciona en los dos escenarios sin necesidad
de ``alembic stamp``.

- Base con el esquema base (10 tablas): crea ``alembic_version``, pasa por aca sin hacer nada
  y aplica 0002, que le crea las cuatro tablas que le faltan.
- Base creada con el dump completo (14 tablas): pasa por aca sin hacer nada y 0002 tampoco
  hace nada, porque es idempotente.

De esta revision en adelante, todo cambio de esquema es una migracion propia. Esa cadena es el
registro de como el esquema fue ganando garantias de integridad.

Revision ID: 0001
Revises: (ninguna, es la primera)
"""

from typing import Sequence, Union

revision: str = '0001'
down_revision: Union[str, Sequence[str], None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No-op: el esquema base ya existe. Ver el docstring del modulo."""


def downgrade() -> None:
    """No se desarma el baseline.

    Revertir esto significaria borrar el esquema base completo, que no es algo que una
    migracion deba hacer por accidente. Si hace falta partir de cero, se recrea la base.
    """
    raise NotImplementedError(
        "El baseline no se revierte: implicaria borrar el esquema base completo. "
        "Para partir de cero, recrea la base con schema_actualizado.sql."
    )
