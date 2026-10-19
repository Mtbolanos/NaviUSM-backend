-- 003: pisos de edificio como lista explícita, piso de acceso y eliminación de la tabla sala
--
-- Antes: edificio.piso_min / edificio.piso_max (un rango) y una tabla sala sin uso.
-- Ahora: edificio_piso (un registro por piso, con nombre opcional) y edificio.piso_acceso.
--
-- Es idempotente: se puede volver a correr sin efecto. Corre en una sola transacción.
-- Aplicar en bases existentes (respaldar antes):
--   docker compose exec -T db pg_dump -U naviusm -d naviusm -Fc > respaldo_antes_003.dump
--   docker compose exec -T db psql -U naviusm -d naviusm -v ON_ERROR_STOP=1 < migraciones/003_edificio_pisos.sql

BEGIN;

CREATE TABLE IF NOT EXISTS public.edificio_piso (
    edificio_id uuid NOT NULL REFERENCES public.edificio(id) ON DELETE CASCADE,
    organizacion_id uuid NOT NULL REFERENCES public.organizacion(id) ON DELETE CASCADE,
    numero integer NOT NULL,
    nombre character varying(100),
    PRIMARY KEY (edificio_id, numero)
);

ALTER TABLE public.edificio_piso ENABLE ROW LEVEL SECURITY;

ALTER TABLE public.edificio ADD COLUMN IF NOT EXISTS piso_acceso integer DEFAULT 1 NOT NULL;

-- Pasar el rango piso_min..piso_max a filas de edificio_piso (solo si las columnas antiguas siguen existiendo)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'edificio' AND column_name = 'piso_min'
    ) THEN
        INSERT INTO public.edificio_piso (edificio_id, organizacion_id, numero)
        SELECT e.id, e.organizacion_id, g.numero
        FROM public.edificio e,
             generate_series(LEAST(e.piso_min, e.piso_max), GREATEST(e.piso_min, e.piso_max)) AS g(numero)
        ON CONFLICT DO NOTHING;

        -- El acceso es el piso 1 (nivel de calle) si el edificio lo tiene; si no, su piso más bajo
        UPDATE public.edificio
        SET piso_acceso = CASE
            WHEN 1 BETWEEN LEAST(piso_min, piso_max) AND GREATEST(piso_min, piso_max) THEN 1
            ELSE LEAST(piso_min, piso_max)
        END;

        ALTER TABLE public.edificio DROP COLUMN piso_min, DROP COLUMN piso_max;
    END IF;
END $$;

-- Todo edificio debe tener al menos su piso de acceso
INSERT INTO public.edificio_piso (edificio_id, organizacion_id, numero)
SELECT e.id, e.organizacion_id, e.piso_acceso
FROM public.edificio e
WHERE NOT EXISTS (SELECT 1 FROM public.edificio_piso p WHERE p.edificio_id = e.id);

-- La tabla sala nunca se usó (las salas son nodos "Entrada / Sala" del mapa)
DROP TABLE IF EXISTS public.sala;

COMMIT;
