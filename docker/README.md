# Levantar el proyecto con Docker

Setup local reproducible: Postgres+PostGIS con el schema aplicado, y el backend con hot-reload.

## Primera vez

```bash
cp .env.example .env          # completar SECRET_KEY, POSTGRES_PASSWORD y las variables del seed (ver .env.example)
docker compose up --build -d
docker compose run --rm backend python seed.py   # crea la org y el admin definidos en .env + catálogo de características
```

Login: el `ADMIN_EMAIL` y la `ADMIN_PASSWORD` del `.env`, en `http://localhost:8000/admin`. Después del seed, borrar `ADMIN_PASSWORD` del `.env` y ejecutar `docker compose up -d`.

## Día a día

- `docker compose up -d` — levantar (usa la imagen ya buildeada).
- `docker compose logs -f backend` — ver logs en vivo.
- Cambios en `app/`, `static/` o `templates/` se reflejan solos (bind mounts + `uvicorn --reload` + Jinja2 sin cache) — no hace falta rebuild ni restart.
- Cambios en `requirements.txt` o el `Dockerfile` sí requieren `docker compose up --build -d`.
- `docker compose down` — bajar sin perder datos (el volumen de Postgres persiste).
- `docker compose down -v` — bajar y borrar TODOS los datos (vuelve a "primera vez").

## Actualizar una base ya existente (no una nueva)

Si ya tienes una base corriendo (por ejemplo en un servidor), no vuelvas a aplicar `schema_actualizado.sql` completo: aplica solo las migraciones que falten, en orden, desde la carpeta `migraciones/` (respaldar antes). El detalle de cada una está en `docs/BASE-DE-DATOS.md`.

```bash
docker compose exec -T db pg_dump -U naviusm -d naviusm -Fc > respaldo.dump
docker compose exec -T db psql -U naviusm -d naviusm -v ON_ERROR_STOP=1 < migraciones/003_edificio_pisos.sql
```

`migracion_zonas_salas.sql` (raíz del repo) es histórica: solo sirve para bases anteriores a las zonas.

## Notas

- La base usa `postgis/postgis:16-3.4` (no `postgres` puro) porque el schema depende de la extensión PostGIS.
- `docker/init/01-init.sh` solo corre una vez, cuando el volumen de datos está vacío — si editas `schema_actualizado.sql` y quieres que se re-aplique, hay que `docker compose down -v` primero.
- El puerto de Postgres (5432) no está expuesto al host a propósito — solo el backend (8000) lo necesita, y así no choca con un Postgres que ya tengas corriendo local.
- `POSTGRES_USER`, `POSTGRES_PASSWORD` y `POSTGRES_DB` solo se aplican al crear el volumen. Para cambiar la clave de una base existente: `\password <usuario>` dentro de `psql` (`docker compose exec db psql -U naviusm -d naviusm`), y después actualizar el `.env` y ejecutar `docker compose up -d`.
