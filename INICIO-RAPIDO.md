# Inicio rápido

Requisito: tener Docker y Docker Compose instalados.

## 1. Clonar

```bash
git clone <url-del-repo>
cd NaviUSM-backend
```

`main` es la versión productiva. El desarrollo se hace en ramas `feature/*` creadas desde `develop`.

## 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Completar el `.env`. Las credenciales no traen valores por defecto, y sin ellas el proyecto no levanta:

- `SECRET_KEY`: `openssl rand -base64 32 | tr '+/' '-_'`
- `POSTGRES_PASSWORD`: `openssl rand -hex 32`
- `ORG_NOMBRE`, `ORG_SLUG`, `ADMIN_EMAIL` y `ADMIN_PASSWORD` (mínimo 12 caracteres): la organización y el admin inicial que crea el seed.
- `COOKIE_SECURE=false` para `http://localhost`; `true` detrás de HTTPS.

## 3. Levantar todo con Docker

```bash
docker compose up --build -d
```

Esto levanta Postgres+PostGIS y el backend, y aplica automáticamente el schema (`schema_actualizado.sql`) porque el volumen de datos es nuevo.

## 4. Crear la organización y el admin inicial

```bash
docker compose run --rm backend python seed.py
```

Crea la organización y el admin definidos en el `.env`, más el catálogo de características de zonas. Se puede correr varias veces: si ya existen, no duplica nada ni cambia la clave del admin. Las sedes se crean desde **Gestión de Sedes** en el panel.

Después de correrlo, borrar `ADMIN_PASSWORD` del `.env` y ejecutar `docker compose up -d`. Todo el `.env` queda como variables de entorno del contenedor backend.

## 5. Entrar

Abrir `http://localhost:8000/admin` e iniciar sesión con el `ADMIN_EMAIL` y la `ADMIN_PASSWORD` definidos en el `.env`. El puerto se cambia con `NAVIUSM_PORT`.

## Día a día (después de la primera vez)

- `docker compose up -d` — levantar de nuevo (ya no hace falta `--build` a menos que cambien `requirements.txt` o el `Dockerfile`).
- Cambios en `app/`, `static/` o `templates/` se ven solos con solo refrescar el navegador — no hace falta reiniciar nada.
- `docker compose down` — bajar sin perder datos.
- `docker compose down -v` — bajar y borrar TODO (vuelve al estado de "primera vez").

## Si alguien ya tiene una base con datos reales de antes (no un clone limpio)

No corran `schema_actualizado.sql` completo de nuevo: apliquen las migraciones de `migraciones/` que falten, en orden (no borran datos; respaldar antes). Ver `docs/BASE-DE-DATOS.md`.

Ver también `docker/README.md` para más detalle sobre el setup de Docker.

## Más documentación

- `docs/CHANGELOG.md` — resumen de todo el trabajo de la sesión que agregó Zonas/Salas/Docker, agrupado por tema.
- `docs/CAMBIOS-JSON-SNAPSHOT.md` — cómo cambió la forma del JSON público (pisos de edificio en el formato 2.2, key `zonas`, campos de nodos tipo `servicio`).
- `docs/BASE-DE-DATOS.md` — tablas, relaciones, qué se escribe al publicar y cómo aplicar migraciones.
- `docs/MAPEO-REESTRUCTURACION.md` — mapa de qué archivo plano (de `origin/develop`) quedó dónde dentro del paquete `app/`, útil para reconciliar ambas ramas.
