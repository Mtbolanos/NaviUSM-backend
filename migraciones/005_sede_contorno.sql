-- 005: contorno opcional de la sede
--
-- Polígono que delimita el campus. Si existe, el editor (Dibujar Mapa) queda limitado a esa área y no
-- permite nodos fuera de ella; la app lo recibe en GET /api/organizacion (sedes[].contorno).
-- NULL = sin límite (comportamiento anterior).
--
-- Es idempotente. Aplicar en bases existentes (respaldar antes):
--   docker compose exec -T db pg_dump -U naviusm -d naviusm -Fc > respaldo_antes_005.dump
--   docker compose exec -T db psql -U naviusm -d naviusm -v ON_ERROR_STOP=1 < migraciones/005_sede_contorno.sql

BEGIN;

ALTER TABLE public.sede ADD COLUMN IF NOT EXISTS contorno public.geometry(Polygon, 4326);

COMMIT;
