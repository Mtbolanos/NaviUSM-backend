--
-- PostgreSQL database dump
--

\restrict B9rzUnOpQ934M09tfqDk8ZFB4geUrF4uuz2nd23p5IYoLyig3wiZiEJJHL3316n

-- Dumped from database version 18.4 (Homebrew)
-- Dumped by pg_dump version 18.4 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
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
    CONSTRAINT chk_origen_destino CHECK ((origen_id <> destino_id))
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
    created_at timestamp with time zone DEFAULT now()
);


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
    categoria character varying(100) NOT NULL
);


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
-- Name: arista arista_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.arista
    ADD CONSTRAINT arista_pkey PRIMARY KEY (id);


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
-- Name: arista; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.arista ENABLE ROW LEVEL SECURITY;

--
-- Name: nodo; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.nodo ENABLE ROW LEVEL SECURITY;

--
-- Name: poi; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.poi ENABLE ROW LEVEL SECURITY;

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
-- PostgreSQL database dump complete
--

\unrestrict B9rzUnOpQ934M09tfqDk8ZFB4geUrF4uuz2nd23p5IYoLyig3wiZiEJJHL3316n

