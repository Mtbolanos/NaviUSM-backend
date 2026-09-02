# Levantar el proyecto con Docker

Setup local reproducible: Postgres+PostGIS con el schema aplicado, y el backend con hot-reload.

## Primera vez

```bash
cp .env.example .env          # ajusta SECRET_KEY si quieres una propia
docker compose up --build -d
docker compose exec backend python seed.py   # crea org/usuario/sede de prueba + catálogo de características
```

Login de prueba: `admin@usm.cl` / `admin123` en `http://localhost:8000/admin`.

## Día a día

- `docker compose up -d` — levantar (usa la imagen ya buildeada).
- `docker compose logs -f backend` — ver logs en vivo.
- Cambios en `app/`, `static/` o `templates/` se reflejan solos (bind mounts + `uvicorn --reload` + Jinja2 sin cache) — no hace falta rebuild ni restart.
- Cambios en `requirements.txt` o el `Dockerfile` sí requieren `docker compose up --build -d`.
- `docker compose down` — bajar sin perder datos (el volumen de Postgres persiste).
- `docker compose down -v` — bajar y borrar TODOS los datos (vuelve a "primera vez").

## Actualizar una base ya existente (no una nueva)

Si ya tienes una base corriendo (por ejemplo en un servidor) de antes de esta sesión, no vuelvas a aplicar `schema_actualizado.sql` completo — usa `migracion_zonas_salas.sql` (raíz del repo), que agrega solo lo nuevo (tablas `sala`/`zona`/`caracteristica`/`zona_caracteristica` y columnas de `poi`) sin tocar tus datos:

```bash
psql -U <usuario> -d <base> -f migracion_zonas_salas.sql
```

## Notas

- La base usa `postgis/postgis:16-3.4` (no `postgres` puro) porque el schema depende de la extensión PostGIS.
- `docker/init/01-init.sh` solo corre una vez, cuando el volumen de datos está vacío — si editas `schema_actualizado.sql` y quieres que se re-aplique, hay que `docker compose down -v` primero.
- El puerto de Postgres (5432) no está expuesto al host a propósito — solo el backend (8000) lo necesita, y así no choca con un Postgres que ya tengas corriendo local.
