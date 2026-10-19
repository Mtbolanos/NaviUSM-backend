-- 004: conectores verticales (escalera, ascensor, rampa) entre pisos de un edificio
--
-- Un conector agrupa sus paradas: un nodo por piso (nodo.conector_id). Las paradas consecutivas se unen
-- con aristas; la de una escalera lleva es_escalera = true (la ruta accesible la evita).
--
-- Es idempotente. Aplicar en bases existentes (respaldar antes):
--   docker compose exec -T db pg_dump -U naviusm -d naviusm -Fc > respaldo_antes_004.dump
--   docker compose exec -T db psql -U naviusm -d naviusm -v ON_ERROR_STOP=1 < migraciones/004_conectores.sql

BEGIN;

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

COMMIT;
