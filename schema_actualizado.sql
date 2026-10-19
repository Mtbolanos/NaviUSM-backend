--
-- PostgreSQL database dump
--

-- Dumped from database version 16.4 (Debian 16.4-1.pgdg110+2)
-- Dumped by pg_dump version 16.4 (Debian 16.4-1.pgdg110+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: postgis; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;


--
-- Name: EXTENSION postgis; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION postgis IS 'PostGIS geometry and geography spatial types and functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: arista; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.arista (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    origen_id uuid NOT NULL,
    destino_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    distancia numeric(10,4) NOT NULL,
    es_bidireccional boolean DEFAULT true,
    es_accesible boolean DEFAULT true,
    source integer,
    target integer,
    es_escalera boolean DEFAULT false,
    CONSTRAINT chk_origen_destino CHECK ((origen_id <> destino_id))
);


--
-- Name: caracteristica; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caracteristica (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    codigo character varying(100) NOT NULL,
    nombre character varying(255) NOT NULL,
    color_hex character varying(7) NOT NULL
);


--
-- Name: edificio; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edificio (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    nombre character varying(255) NOT NULL,
    piso_acceso integer DEFAULT 1 NOT NULL
);


--
-- Name: edificio_piso; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edificio_piso (
    edificio_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    numero integer NOT NULL,
    nombre character varying(100)
);


--
-- Name: nodo; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.nodo (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    geom public.geometry(PointZ,4326) NOT NULL,
    piso integer DEFAULT 1 NOT NULL,
    tipo character varying(50) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    edificio_id uuid,
    gid integer NOT NULL
);


--
-- Name: nodo_gid_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.nodo_gid_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: nodo_gid_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.nodo_gid_seq OWNED BY public.nodo.gid;


--
-- Name: organizacion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizacion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre character varying(255) NOT NULL,
    slug character varying(100) NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: poi; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.poi (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nodo_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    nombre character varying(255) NOT NULL,
    categoria character varying(100) NOT NULL,
    horario character varying(255),
    descripcion text,
    link_derivacion character varying(500)
);


--
-- Name: publicacion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.publicacion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    version integer,
    publicado_en timestamp with time zone DEFAULT now() NOT NULL,
    usuario_id uuid,
    origen text NOT NULL,
    resultado text NOT NULL,
    status_http integer NOT NULL,
    motivo text,
    tiempos_ms jsonb,
    validacion jsonb,
    bytes integer,
    conteos jsonb
);


--
-- Name: TABLE publicacion; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.publicacion IS 'Registro de cada ejecucion del pipeline de publicacion del grafo (exito o rechazo). Sobrevive a la retencion de snapshots.';


--
-- Name: COLUMN publicacion.version; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.version IS 'Version de snapshot creada; NULL si la ejecucion no creo version.';


--
-- Name: COLUMN publicacion.publicado_en; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.publicado_en IS 'Momento en que se registro la ejecucion (tambien para los rechazos).';


--
-- Name: COLUMN publicacion.origen; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.origen IS 'Ruta que ejecuto el pipeline: publish (POST /publish) | patch_edificios (PATCH /edificios).';


--
-- Name: COLUMN publicacion.resultado; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.resultado IS 'Valores vigentes: publicado | rechazado. Sin CHECK a proposito: se pueden agregar valores (p. ej. bloqueado_n3).';


--
-- Name: COLUMN publicacion.motivo; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.motivo IS 'detail del error que se devolvio, recortado a 1000 caracteres; NULL si se publico.';


--
-- Name: COLUMN publicacion.tiempos_ms; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.tiempos_ms IS 'tiempos_ms de la respuesta si se publico; en un rechazo, solo total (si se alcanzo a cronometrar).';


--
-- Name: COLUMN publicacion.validacion; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.validacion IS 'Bloque validacion de la respuesta (Nivel 3 informativo); NULL en los rechazos.';


--
-- Name: COLUMN publicacion.bytes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.bytes IS 'Tamano en bytes del cuerpo HTTP recibido (Content-Length).';


--
-- Name: COLUMN publicacion.conteos; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.publicacion.conteos IS 'Largo de cada coleccion lista del payload (nodes, edges, ...).';


--
-- Name: ruta_evacuacion; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ruta_evacuacion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    nombre character varying(255) NOT NULL,
    tipo_emergencia character varying(100) NOT NULL
);


--
-- Name: ruta_evacuacion_arista; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ruta_evacuacion_arista (
    ruta_evacuacion_id uuid NOT NULL,
    arista_id uuid NOT NULL,
    orden integer NOT NULL
);


--
-- Name: sede; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sede (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacion_id uuid NOT NULL,
    nombre character varying(255) NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    latitud numeric(10,7) DEFAULT '-33.036577'::numeric,
    longitud numeric(10,7) DEFAULT '-71.486578'::numeric,
    zoom_defecto integer DEFAULT 17
);


--
-- Name: snapshot; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.snapshot (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    payload jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    published_at timestamp with time zone DEFAULT now()
);


--
-- Name: usuario; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.usuario (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organizacion_id uuid NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    rol character varying(50) DEFAULT 'admin'::character varying NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    last_login timestamp with time zone
);


--
-- Name: zona; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zona (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    sede_id uuid NOT NULL,
    organizacion_id uuid NOT NULL,
    edificio_id uuid,
    nombre character varying(255),
    geom public.geometry(Polygon,4326) NOT NULL,
    color_hex character varying(7)
);


--
-- Name: zona_caracteristica; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.zona_caracteristica (
    zona_id uuid NOT NULL,
    caracteristica_id uuid NOT NULL
);


--
-- Name: nodo gid; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodo ALTER COLUMN gid SET DEFAULT nextval('public.nodo_gid_seq'::regclass);


--
-- Name: arista arista_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arista
    ADD CONSTRAINT arista_pkey PRIMARY KEY (id);


--
-- Name: caracteristica caracteristica_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caracteristica
    ADD CONSTRAINT caracteristica_codigo_key UNIQUE (codigo);


--
-- Name: caracteristica caracteristica_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caracteristica
    ADD CONSTRAINT caracteristica_pkey PRIMARY KEY (id);


--
-- Name: edificio edificio_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edificio
    ADD CONSTRAINT edificio_pkey PRIMARY KEY (id);


--
-- Name: edificio_piso edificio_piso_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edificio_piso
    ADD CONSTRAINT edificio_piso_pkey PRIMARY KEY (edificio_id, numero);


--
-- Name: nodo nodo_gid_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodo
    ADD CONSTRAINT nodo_gid_key UNIQUE (gid);


--
-- Name: nodo nodo_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodo
    ADD CONSTRAINT nodo_pkey PRIMARY KEY (id);


--
-- Name: organizacion organizacion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacion
    ADD CONSTRAINT organizacion_pkey PRIMARY KEY (id);


--
-- Name: organizacion organizacion_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizacion
    ADD CONSTRAINT organizacion_slug_key UNIQUE (slug);


--
-- Name: poi poi_nodo_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poi
    ADD CONSTRAINT poi_nodo_id_key UNIQUE (nodo_id);


--
-- Name: poi poi_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poi
    ADD CONSTRAINT poi_pkey PRIMARY KEY (id);


--
-- Name: publicacion publicacion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publicacion
    ADD CONSTRAINT publicacion_pkey PRIMARY KEY (id);


--
-- Name: ruta_evacuacion_arista ruta_evacuacion_arista_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ruta_evacuacion_arista
    ADD CONSTRAINT ruta_evacuacion_arista_pkey PRIMARY KEY (ruta_evacuacion_id, arista_id);


--
-- Name: ruta_evacuacion ruta_evacuacion_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ruta_evacuacion
    ADD CONSTRAINT ruta_evacuacion_pkey PRIMARY KEY (id);


--
-- Name: sede sede_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sede
    ADD CONSTRAINT sede_pkey PRIMARY KEY (id);


--
-- Name: snapshot snapshot_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot
    ADD CONSTRAINT snapshot_pkey PRIMARY KEY (id);


--
-- Name: usuario usuario_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuario
    ADD CONSTRAINT usuario_email_key UNIQUE (email);


--
-- Name: usuario usuario_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuario
    ADD CONSTRAINT usuario_pkey PRIMARY KEY (id);


--
-- Name: zona_caracteristica zona_caracteristica_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zona_caracteristica
    ADD CONSTRAINT zona_caracteristica_pkey PRIMARY KEY (zona_id, caracteristica_id);


--
-- Name: zona zona_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zona
    ADD CONSTRAINT zona_pkey PRIMARY KEY (id);


--
-- Name: idx_arista_destino; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arista_destino ON public.arista USING btree (destino_id);


--
-- Name: idx_arista_organizacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arista_organizacion ON public.arista USING btree (organizacion_id);


--
-- Name: idx_arista_origen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_arista_origen ON public.arista USING btree (origen_id);


--
-- Name: idx_nodo_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodo_geom ON public.nodo USING gist (geom);


--
-- Name: idx_nodo_organizacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodo_organizacion ON public.nodo USING btree (organizacion_id);


--
-- Name: idx_nodo_sede; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_nodo_sede ON public.nodo USING btree (sede_id);


--
-- Name: idx_poi_organizacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_poi_organizacion ON public.poi USING btree (organizacion_id);


--
-- Name: idx_publicacion_sede_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_publicacion_sede_fecha ON public.publicacion USING btree (sede_id, publicado_en DESC);


--
-- Name: idx_rea_arista; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rea_arista ON public.ruta_evacuacion_arista USING btree (arista_id);


--
-- Name: idx_ruta_evacuacion_sede; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ruta_evacuacion_sede ON public.ruta_evacuacion USING btree (sede_id);


--
-- Name: idx_sede_organizacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_sede_organizacion ON public.sede USING btree (organizacion_id);


--
-- Name: idx_snapshot_sede; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_snapshot_sede ON public.snapshot USING btree (sede_id);


--
-- Name: idx_usuario_organizacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_usuario_organizacion ON public.usuario USING btree (organizacion_id);


--
-- Name: idx_zc_caracteristica; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zc_caracteristica ON public.zona_caracteristica USING btree (caracteristica_id);


--
-- Name: idx_zona_geom; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zona_geom ON public.zona USING gist (geom);


--
-- Name: idx_zona_organizacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zona_organizacion ON public.zona USING btree (organizacion_id);


--
-- Name: idx_zona_sede; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_zona_sede ON public.zona USING btree (sede_id);


--
-- Name: arista arista_destino_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arista
    ADD CONSTRAINT arista_destino_id_fkey FOREIGN KEY (destino_id) REFERENCES public.nodo(id) ON DELETE CASCADE;


--
-- Name: arista arista_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arista
    ADD CONSTRAINT arista_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: arista arista_origen_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arista
    ADD CONSTRAINT arista_origen_id_fkey FOREIGN KEY (origen_id) REFERENCES public.nodo(id) ON DELETE CASCADE;


--
-- Name: edificio edificio_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edificio
    ADD CONSTRAINT edificio_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: edificio_piso edificio_piso_edificio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edificio_piso
    ADD CONSTRAINT edificio_piso_edificio_id_fkey FOREIGN KEY (edificio_id) REFERENCES public.edificio(id) ON DELETE CASCADE;


--
-- Name: edificio_piso edificio_piso_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edificio_piso
    ADD CONSTRAINT edificio_piso_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: edificio edificio_sede_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edificio
    ADD CONSTRAINT edificio_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES public.sede(id) ON DELETE CASCADE;


--
-- Name: nodo nodo_edificio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodo
    ADD CONSTRAINT nodo_edificio_id_fkey FOREIGN KEY (edificio_id) REFERENCES public.edificio(id) ON DELETE CASCADE;


--
-- Name: nodo nodo_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodo
    ADD CONSTRAINT nodo_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: nodo nodo_sede_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.nodo
    ADD CONSTRAINT nodo_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES public.sede(id) ON DELETE CASCADE;


--
-- Name: poi poi_nodo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poi
    ADD CONSTRAINT poi_nodo_id_fkey FOREIGN KEY (nodo_id) REFERENCES public.nodo(id) ON DELETE CASCADE;


--
-- Name: poi poi_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.poi
    ADD CONSTRAINT poi_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: publicacion publicacion_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publicacion
    ADD CONSTRAINT publicacion_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: publicacion publicacion_sede_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publicacion
    ADD CONSTRAINT publicacion_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES public.sede(id) ON DELETE CASCADE;


--
-- Name: publicacion publicacion_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.publicacion
    ADD CONSTRAINT publicacion_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.usuario(id) ON DELETE SET NULL;


--
-- Name: ruta_evacuacion_arista ruta_evacuacion_arista_arista_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ruta_evacuacion_arista
    ADD CONSTRAINT ruta_evacuacion_arista_arista_id_fkey FOREIGN KEY (arista_id) REFERENCES public.arista(id) ON DELETE CASCADE;


--
-- Name: ruta_evacuacion_arista ruta_evacuacion_arista_ruta_evacuacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ruta_evacuacion_arista
    ADD CONSTRAINT ruta_evacuacion_arista_ruta_evacuacion_id_fkey FOREIGN KEY (ruta_evacuacion_id) REFERENCES public.ruta_evacuacion(id) ON DELETE CASCADE;


--
-- Name: ruta_evacuacion ruta_evacuacion_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ruta_evacuacion
    ADD CONSTRAINT ruta_evacuacion_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: ruta_evacuacion ruta_evacuacion_sede_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ruta_evacuacion
    ADD CONSTRAINT ruta_evacuacion_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES public.sede(id) ON DELETE CASCADE;


--
-- Name: sede sede_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sede
    ADD CONSTRAINT sede_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: snapshot snapshot_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot
    ADD CONSTRAINT snapshot_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: snapshot snapshot_sede_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.snapshot
    ADD CONSTRAINT snapshot_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES public.sede(id) ON DELETE CASCADE;


--
-- Name: usuario usuario_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.usuario
    ADD CONSTRAINT usuario_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: zona_caracteristica zona_caracteristica_caracteristica_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zona_caracteristica
    ADD CONSTRAINT zona_caracteristica_caracteristica_id_fkey FOREIGN KEY (caracteristica_id) REFERENCES public.caracteristica(id) ON DELETE CASCADE;


--
-- Name: zona_caracteristica zona_caracteristica_zona_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zona_caracteristica
    ADD CONSTRAINT zona_caracteristica_zona_id_fkey FOREIGN KEY (zona_id) REFERENCES public.zona(id) ON DELETE CASCADE;


--
-- Name: zona zona_edificio_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zona
    ADD CONSTRAINT zona_edificio_id_fkey FOREIGN KEY (edificio_id) REFERENCES public.edificio(id) ON DELETE CASCADE;


--
-- Name: zona zona_organizacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zona
    ADD CONSTRAINT zona_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES public.organizacion(id) ON DELETE CASCADE;


--
-- Name: zona zona_sede_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.zona
    ADD CONSTRAINT zona_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES public.sede(id) ON DELETE CASCADE;


--
-- Name: arista; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.arista ENABLE ROW LEVEL SECURITY;

--
-- Name: edificio_piso; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.edificio_piso ENABLE ROW LEVEL SECURITY;

--
-- Name: nodo; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.nodo ENABLE ROW LEVEL SECURITY;

--
-- Name: poi; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.poi ENABLE ROW LEVEL SECURITY;

--
-- Name: publicacion; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.publicacion ENABLE ROW LEVEL SECURITY;

--
-- Name: ruta_evacuacion; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ruta_evacuacion ENABLE ROW LEVEL SECURITY;

--
-- Name: sede; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sede ENABLE ROW LEVEL SECURITY;

--
-- Name: snapshot; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.snapshot ENABLE ROW LEVEL SECURITY;

--
-- Name: usuario; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.usuario ENABLE ROW LEVEL SECURITY;

--
-- Name: zona; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.zona ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

--
-- Migraciones posteriores al dump (instalaciones nuevas)
--

-- 002: API keys por organización para la app móvil
-- Aplicar en bases existentes:
--   docker compose exec -T db psql -U naviusm -d naviusm -v ON_ERROR_STOP=1 < migraciones/002_api_keys.sql

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

-- 003: pisos de edificio (edificio_piso, edificio.piso_acceso) y eliminación de sala
-- Ya incluido arriba para instalaciones nuevas. En bases existentes aplicar migraciones/003_edificio_pisos.sql

-- 004: conectores verticales (escalera, ascensor, rampa) y nodo.conector_id
-- En bases existentes aplicar migraciones/004_conectores.sql (este bloque es el mismo contenido)

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

-- 005: contorno opcional de la sede (NULL = sin límite)
-- En bases existentes aplicar migraciones/005_sede_contorno.sql (este bloque es el mismo contenido)

ALTER TABLE public.sede ADD COLUMN IF NOT EXISTS contorno public.geometry(Polygon, 4326);

-- 0010 (Alembic): snapshot guarda sus cambios respecto a la version anterior (columna cambios,
-- trigger snapshot_cambios y funcion diferencias_grafo). Mismo contenido que migrations/versions/0010_snapshot_cambios.py
ALTER TABLE public.snapshot
    ADD COLUMN IF NOT EXISTS cambios jsonb,
    ADD COLUMN IF NOT EXISTS restaurada_de integer;

COMMENT ON COLUMN public.snapshot.cambios IS 'Diferencia con la version anterior de la sede (diferencias_grafo). La llena el trigger snapshot_cambios. NULL en la primera version o si la comparacion fallo.';
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
        BEGIN
            NEW.cambios := jsonb_build_object('desde', previo.version, 'hasta', NEW.version)
                           || coalesce(public.diferencias_grafo(previo.payload, NEW.payload), '{}'::jsonb);
        EXCEPTION WHEN OTHERS THEN
            -- El historial nunca frena una publicacion: sin comparacion, la version entra con cambios NULL.
            -- (sin marcadores con porcentaje: psycopg2 los tomaria como parametros al migrar)
            RAISE WARNING USING MESSAGE = 'snapshot_cambios: no se pudo comparar sede ' || NEW.sede_id
                || ' v' || NEW.version || ' con v' || previo.version || ': ' || SQLERRM;
            NEW.cambios := NULL;
        END;
    END IF;
    RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS snapshot_cambios ON public.snapshot;
CREATE TRIGGER snapshot_cambios BEFORE INSERT ON public.snapshot
    FOR EACH ROW EXECUTE FUNCTION public.snapshot_calcular_cambios();

-- 0011 (Alembic): reglas del Nivel 1 (distancia positiva, una arista por par, un nodo por coordenada y piso,
-- coordenadas en rango, geometria valida en zonas). Mismo contenido que migrations/versions/0011_reglas_n1.py
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_arista_distancia_positiva') THEN
        ALTER TABLE public.arista ADD CONSTRAINT chk_arista_distancia_positiva CHECK (distancia > 0);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'excl_arista_par_unico') THEN
        ALTER TABLE public.arista ADD CONSTRAINT excl_arista_par_unico
            EXCLUDE USING btree ((LEAST(origen_id, destino_id)) WITH =, (GREATEST(origen_id, destino_id)) WITH =)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'excl_nodo_coordenada_piso') THEN
        ALTER TABLE public.nodo ADD CONSTRAINT excl_nodo_coordenada_piso
            EXCLUDE USING btree (sede_id WITH =, piso WITH =, (public.ST_X(geom)) WITH =, (public.ST_Y(geom)) WITH =)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_nodo_coordenadas_rango') THEN
        ALTER TABLE public.nodo ADD CONSTRAINT chk_nodo_coordenadas_rango
            CHECK (public.ST_X(geom) BETWEEN -180 AND 180 AND public.ST_Y(geom) BETWEEN -90 AND 90);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_zona_geometria_valida') THEN
        ALTER TABLE public.zona ADD CONSTRAINT chk_zona_geometria_valida CHECK (public.ST_IsValid(geom));
    END IF;
END $$;

COMMENT ON CONSTRAINT chk_arista_distancia_positiva ON public.arista IS 'Nivel 1: la distancia de una arista es mayor que 0.';
COMMENT ON CONSTRAINT excl_arista_par_unico ON public.arista IS 'Nivel 1: una sola arista por par de nodos, en cualquier direccion. Diferida: se revisa en el COMMIT.';
COMMENT ON CONSTRAINT excl_nodo_coordenada_piso ON public.nodo IS 'Nivel 1: un solo nodo por coordenada y piso en cada sede. Diferida: se revisa en el COMMIT.';
COMMENT ON CONSTRAINT chk_nodo_coordenadas_rango ON public.nodo IS 'Nivel 1: longitud entre -180 y 180, latitud entre -90 y 90.';
COMMENT ON CONSTRAINT chk_zona_geometria_valida ON public.zona IS 'Nivel 1: la geometria de la zona es valida (ST_IsValid).';

-- 0012 (Alembic): el trigger snapshot_cambios guarda restaurada_de desde SET LOCAL naviusm.restaurada_de.
-- Mismo contenido que migrations/versions/0012_restaurada_de.py
CREATE OR REPLACE FUNCTION public.snapshot_calcular_cambios() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    previo record;
    origen text;
BEGIN
    -- Restaurar (0012): restaurar_version marca su transaccion con SET LOCAL naviusm.restaurada_de.
    -- Fuera de esa transaccion el valor vuelve a ser vacio. Un valor no numerico se ignora.
    IF NEW.restaurada_de IS NULL THEN
        origen := current_setting('naviusm.restaurada_de', true);
        IF origen ~ '^[0-9]+$' THEN
            NEW.restaurada_de := origen::integer;
        END IF;
    END IF;
    IF NEW.cambios IS NOT NULL THEN
        RETURN NEW;
    END IF;
    SELECT version, payload INTO previo
    FROM public.snapshot
    WHERE sede_id = NEW.sede_id AND version < NEW.version
    ORDER BY version DESC
    LIMIT 1;
    IF FOUND THEN
        BEGIN
            NEW.cambios := jsonb_build_object('desde', previo.version, 'hasta', NEW.version)
                           || coalesce(public.diferencias_grafo(previo.payload, NEW.payload), '{}'::jsonb);
        EXCEPTION WHEN OTHERS THEN
            -- El historial nunca frena una publicacion: sin comparacion, la version entra con cambios NULL.
            -- (sin marcadores con porcentaje: psycopg2 los tomaria como parametros al migrar)
            RAISE WARNING USING MESSAGE = 'snapshot_cambios: no se pudo comparar sede ' || NEW.sede_id
                || ' v' || NEW.version || ' con v' || previo.version || ': ' || SQLERRM;
            NEW.cambios := NULL;
        END;
    END IF;
    RETURN NEW;
END
$$;

COMMENT ON COLUMN public.snapshot.restaurada_de IS 'Version de origen si esta version vino de restaurar una anterior; la escribe el trigger snapshot_cambios desde SET LOCAL naviusm.restaurada_de (migracion 0012). NULL si no.';
