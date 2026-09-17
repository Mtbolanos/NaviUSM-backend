"""zonas y salas

Crea las cuatro tablas del sprint de zonas y salas (``sala``, ``caracteristica``, ``zona``,
``zona_caracteristica``), agrega las tres columnas de contacto a ``poi`` y siembra el catalogo
inicial de caracteristicas.

El SQL es el de ``migracion_zonas_salas.sql``, sin sus sentencias ``BEGIN``/``COMMIT`` porque
la transaccion la maneja Alembic. Va embebido y no leido del archivo a proposito: una migracion
tiene que ser inmutable para que el historial sea reproducible; si leyera el .sql y ese archivo
cambiara, esta revision significaria algo distinto manana.

Es idempotente (``IF NOT EXISTS`` / ``ON CONFLICT`` / bloques ``DO`` que ignoran duplicados), asi
que aplica tanto sobre una base que viene del esquema base de 10 tablas como sobre una creada con
el dump completo, donde no hace nada.

Revision ID: 0002
Revises: 0001
"""

from typing import Sequence, Union

from alembic import op

revision: str = '0002'
down_revision: Union[str, Sequence[str], None] = '0001'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Se ejecuta con exec_driver_sql para que el driver reciba el DDL tal cual: los bloques
# DO $$ ... $$ no deben pasar por el parser de binds de SQLAlchemy.
_UPGRADE = """
-- 1. Columnas nuevas en poi (info de contacto para nodos tipo "servicio")
ALTER TABLE public.poi ADD COLUMN IF NOT EXISTS horario character varying(255);
ALTER TABLE public.poi ADD COLUMN IF NOT EXISTS descripcion text;
ALTER TABLE public.poi ADD COLUMN IF NOT EXISTS link_derivacion character varying(500);

-- 2. Tabla sala (gestión de salas por piso, sin geometría)
CREATE TABLE IF NOT EXISTS public.sala (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    edificio_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    piso integer NOT NULL,
    nombre character varying(255) NOT NULL
);

ALTER TABLE public.sala OWNER TO CURRENT_USER;

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

-- 3. Tabla caracteristica (catálogo de etiquetas de zona)
CREATE TABLE IF NOT EXISTS public.caracteristica (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    codigo character varying(100) NOT NULL,
    nombre character varying(255) NOT NULL,
    color_hex character varying(7) NOT NULL
);

ALTER TABLE public.caracteristica OWNER TO CURRENT_USER;

DO $$ BEGIN
    ALTER TABLE ONLY public.caracteristica ADD CONSTRAINT caracteristica_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.caracteristica ADD CONSTRAINT caracteristica_codigo_key UNIQUE (codigo);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

-- 4. Tabla zona (contornos de edificio y zonas seguras, con geometría)
CREATE TABLE IF NOT EXISTS public.zona (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    edificio_id uuid,
    nombre character varying(255),
    geom public.geometry(Polygon,4326) NOT NULL,
    color_hex character varying(7)
);

ALTER TABLE public.zona OWNER TO CURRENT_USER;

DO $$ BEGIN
    ALTER TABLE ONLY public.zona ADD CONSTRAINT zona_pkey PRIMARY KEY (id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.zona
        ADD CONSTRAINT zona_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES public.sede(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.zona
        ADD CONSTRAINT zona_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.zona
        ADD CONSTRAINT zona_edificio_id_fkey FOREIGN KEY (edificio_id) REFERENCES public.edificio(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_zona_geom ON public.zona USING gist (geom);
CREATE INDEX IF NOT EXISTS idx_zona_sede ON public.zona USING btree (sede_id);
CREATE INDEX IF NOT EXISTS idx_zona_organizacion ON public.zona USING btree (organizacion_id);

ALTER TABLE public.zona ENABLE ROW LEVEL SECURITY;

-- 5. Tabla zona_caracteristica (join: una zona puede llevar varias etiquetas)
CREATE TABLE IF NOT EXISTS public.zona_caracteristica (
    zona_id uuid NOT NULL,
    caracteristica_id uuid NOT NULL
);

ALTER TABLE public.zona_caracteristica OWNER TO CURRENT_USER;

DO $$ BEGIN
    ALTER TABLE ONLY public.zona_caracteristica
        ADD CONSTRAINT zona_caracteristica_pkey PRIMARY KEY (zona_id, caracteristica_id);
EXCEPTION WHEN duplicate_table OR invalid_table_definition THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.zona_caracteristica
        ADD CONSTRAINT zona_caracteristica_zona_id_fkey FOREIGN KEY (zona_id) REFERENCES public.zona(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE ONLY public.zona_caracteristica
        ADD CONSTRAINT zona_caracteristica_caracteristica_id_fkey FOREIGN KEY (caracteristica_id) REFERENCES public.caracteristica(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object OR duplicate_table THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_zc_caracteristica ON public.zona_caracteristica USING btree (caracteristica_id);

-- 6. Catálogo inicial de características (mismo contenido que seed.py::seed_caracteristicas)
INSERT INTO public.caracteristica (codigo, nombre, color_hex) VALUES
    ('zona_segura', 'Zona segura', '#1f7a5c'),
    ('zona_silenciosa', 'Zona silenciosa', '#5c4d99'),
    ('accesible_silla_ruedas', 'Accesible en silla de ruedas', '#b5651d'),
    ('contorno_edificio', 'Contorno de edificio', '#3b6e8f')
ON CONFLICT (codigo) DO NOTHING;
"""

_DOWNGRADE = """
DROP TABLE IF EXISTS public.zona_caracteristica;
DROP TABLE IF EXISTS public.zona;
DROP TABLE IF EXISTS public.caracteristica;
DROP TABLE IF EXISTS public.sala;

ALTER TABLE public.poi DROP COLUMN IF EXISTS link_derivacion;
ALTER TABLE public.poi DROP COLUMN IF EXISTS descripcion;
ALTER TABLE public.poi DROP COLUMN IF EXISTS horario;
"""


def upgrade() -> None:
    op.get_bind().exec_driver_sql(_UPGRADE)


def downgrade() -> None:
    """Revierte de verdad: borra las cuatro tablas y las tres columnas.

    ``zona_caracteristica`` va primero porque referencia a ``zona`` y ``caracteristica``.
    Destruye los datos de zonas y salas, como corresponde a un downgrade.
    """
    op.get_bind().exec_driver_sql(_DOWNGRADE)
