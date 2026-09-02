# Inicio rápido

Requisito: tener Docker y Docker Compose instalados.

## 1. Clonar y elegir la rama correcta

```bash
git clone <url-del-repo>
cd NaviUSM-backend
git checkout feature/zonas-y-salas
```

⚠️ **Importante:** no usar `develop` por ahora. `develop` remoto quedó con la estructura vieja (archivos planos, sin `app/`) desde el revert que se hizo para la demo — todo lo nuevo (Zonas, Salas, geolocalización, Docker) vive en `feature/zonas-y-salas`.

## 2. Configurar variables de entorno

```bash
cp .env.example .env
```

El `.env.example` ya trae valores que funcionan out-of-the-box para desarrollo local, no hace falta tocar nada salvo que quieran su propia `SECRET_KEY`.

## 3. Levantar todo con Docker

```bash
docker compose up --build -d
```

Esto levanta Postgres+PostGIS y el backend, y aplica automáticamente todo el schema (`schema_actualizado.sql`) porque el volumen de datos es nuevo.

## 4. Poblar datos de prueba

```bash
docker compose exec backend python seed.py
```

Crea una organización, un usuario admin y una sede de prueba, más el catálogo de características de zonas (zona segura, zona silenciosa, etc). Solo hace falta correrlo una vez — si ya existen esos datos, el script lo detecta y no duplica nada.

## 5. Entrar

Abrir `http://localhost:8000/admin` — login con `admin@usm.cl` / `admin123`.

## Día a día (después de la primera vez)

- `docker compose up -d` — levantar de nuevo (ya no hace falta `--build` a menos que cambien `requirements.txt` o el `Dockerfile`).
- Cambios en `app/`, `static/` o `templates/` se ven solos con solo refrescar el navegador — no hace falta reiniciar nada.
- `docker compose down` — bajar sin perder datos.
- `docker compose down -v` — bajar y borrar TODO (vuelve al estado de "primera vez").

## Si alguien ya tiene una base con datos reales de antes (no un clone limpio)

No corran `schema_actualizado.sql` completo de nuevo — usen el script incremental que no borra nada:

```bash
psql -U <usuario> -d <base> -f migracion_zonas_salas.sql
```

Ver también `docker/README.md` para más detalle sobre el setup de Docker.

## Más documentación

- `docs/CHANGELOG.md` — resumen de todo el trabajo de la sesión que agregó Zonas/Salas/Docker, agrupado por tema.
- `docs/CAMBIOS-JSON-SNAPSHOT.md` — cómo cambió la forma del JSON público (nueva key `zonas`, campos nuevos en nodos tipo `servicio`).
- `docs/MAPEO-REESTRUCTURACION.md` — mapa de qué archivo plano (de `origin/develop`) quedó dónde dentro del paquete `app/`, útil para reconciliar ambas ramas.
