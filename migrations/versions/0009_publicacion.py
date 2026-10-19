"""registro de ejecuciones del pipeline de publicacion

Crea la tabla ``publicacion``: una fila por cada ejecucion del publish del grafo (``POST /publish``
y ``PATCH /edificios``), exitosa o rechazada, con su resultado, status HTTP, motivo del rechazo,
tiempos por etapa, bloque de validacion, tamano del cuerpo y conteos del payload. La escribe
``app/grafo/registro.py``.

Es una tabla aparte de ``snapshot`` a proposito: ``publish_graph_data`` (paso 8, retencion) borra
los snapshots viejos, y el registro tiene que sobrevivirles. Por lo mismo no guarda el payload.

``resultado`` es texto sin CHECK cerrado: hoy toma 'publicado' o 'rechazado', y se espera agregar
otros (p. ej. 'bloqueado_n3') sin migrar el constraint. Los valores vigentes van en el COMMENT.

Idempotente (``IF NOT EXISTS``; ENABLE RLS y COMMENT se pueden repetir). RLS habilitado sin
politicas, igual que el resto de las tablas de la organizacion.

Revision ID: 0009
Revises: 0008
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0009'
down_revision: Union[str, Sequence[str], None] = '0008'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_UPGRADE = """
CREATE TABLE IF NOT EXISTS public.publicacion (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    sede_id uuid NOT NULL REFERENCES public.sede(id) ON DELETE CASCADE,
    organizacion_id uuid NOT NULL REFERENCES public.organizacion(id) ON DELETE CASCADE,
    version integer,
    publicado_en timestamp with time zone DEFAULT now() NOT NULL,
    usuario_id uuid REFERENCES public.usuario(id) ON DELETE SET NULL,
    origen text NOT NULL,
    resultado text NOT NULL,
    status_http integer NOT NULL,
    motivo text,
    tiempos_ms jsonb,
    validacion jsonb,
    bytes integer,
    conteos jsonb
);

CREATE INDEX IF NOT EXISTS idx_publicacion_sede_fecha ON public.publicacion USING btree (sede_id, publicado_en DESC);

ALTER TABLE public.publicacion ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.publicacion IS 'Registro de cada ejecucion del pipeline de publicacion del grafo (exito o rechazo). Sobrevive a la retencion de snapshots.';
COMMENT ON COLUMN public.publicacion.version IS 'Version de snapshot creada; NULL si la ejecucion no creo version.';
COMMENT ON COLUMN public.publicacion.publicado_en IS 'Momento en que se registro la ejecucion (tambien para los rechazos).';
COMMENT ON COLUMN public.publicacion.origen IS 'Ruta que ejecuto el pipeline: publish (POST /publish) | patch_edificios (PATCH /edificios).';
COMMENT ON COLUMN public.publicacion.resultado IS 'Valores vigentes: publicado | rechazado. Sin CHECK a proposito: se pueden agregar valores (p. ej. bloqueado_n3).';
COMMENT ON COLUMN public.publicacion.motivo IS 'detail del error que se devolvio, recortado a 1000 caracteres; NULL si se publico.';
COMMENT ON COLUMN public.publicacion.tiempos_ms IS 'tiempos_ms de la respuesta si se publico; en un rechazo, solo total (si se alcanzo a cronometrar).';
COMMENT ON COLUMN public.publicacion.validacion IS 'Bloque validacion de la respuesta (Nivel 3 informativo); NULL en los rechazos.';
COMMENT ON COLUMN public.publicacion.bytes IS 'Tamano en bytes del cuerpo HTTP recibido (Content-Length).';
COMMENT ON COLUMN public.publicacion.conteos IS 'Largo de cada coleccion lista del payload (nodes, edges, ...).';
"""

_DOWNGRADE = """
DROP TABLE IF EXISTS public.publicacion;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Borra la tabla. Se pierde el historial de ejecuciones (los snapshots no se tocan)."""
    op.get_bind().exec_driver_sql(_DOWNGRADE)
