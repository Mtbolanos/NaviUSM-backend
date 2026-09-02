# Mapeo de reestructuración: archivos planos → paquete `app/`

Contexto: el proyecto empezó con todo en archivos sueltos en la raíz (`main.py`, `models.py`, `crud.py`, `schemas.py`, `auth.py`, `database.py`, `config.py`). Se hizo un refactor a un paquete `app/` dividido por dominio (auth, sedes, grafo, y ahora zonas/salas), pero ese refactor se revirtió en `origin/develop` por bugs cerca de una demo — así que **el develop remoto sigue en la estructura plana vieja**, mientras que esta rama (`feature/zonas-y-salas`) retomó y completó la reestructuración a `app/`. Este documento mapea dónde quedó cada cosa para reconciliar ambas historias más adelante.

## Archivo plano viejo → dónde vive ahora

| Archivo viejo (origin/develop) | Dónde quedó ahora |
|---|---|
| `main.py` | **Dividido**: el bootstrap de FastAPI (creación de `app`, middleware de auth, montaje de `/static`, registro de routers) quedó en `app/main.py`. Cada grupo de rutas que antes vivía acá se movió a su propio router: `/`, `/login`, `/logout`, `/cambiar-contrasena` → `app/auth/router.py`; `/admin`, CRUD de sedes → `app/sedes/router.py`; `/admin/api/sedes/{id}/publish`, `/api/v1/public/sedes/{id}/snapshot`, `/app-test/{id}` → `app/grafo/router.py`. |
| `crud.py` | **Dividido**: `verify_password`, `get_hash_password`, `get_user_by_email` → `app/security.py`. `change_user_password` → `app/auth/crud.py`. La lógica de sedes (crear/borrar) y de publish/snapshot, que en `main.py` viejo estaba inline dentro de las rutas, se extrajo a `app/sedes/crud.py` y `app/grafo/crud.py` respectivamente. |
| `auth.py` | **Dividido**: `set_auth_cookie`, `get_current_user`, `login_user` → `app/security.py` (junto con las funciones de password que venían de `crud.py`, ver arriba). Las rutas que usaban estas funciones → `app/auth/router.py`. |
| `schemas.py` | → `app/auth/schemas.py` (1:1 — `Login`, `ChangePassword`, sin cambios de contenido). Los demás `app/*/schemas.py` (sedes, grafo, zonas, salas) son módulos nuevos que no existían antes, porque el `schemas.py` viejo solo tenía estas dos clases de auth. |
| `models.py` | → `app/models.py` (1:1 — mismas clases `Organizacion`, `Usuario`, `Sede`, `Snapshot`, `Edificio`, más `Sala` y `Caracteristica` agregadas en esta sesión). |
| `database.py` | → `app/database.py` (1:1, solo cambia el import de config: `from config import DATABASE_URL` → `from app.config import settings`). |
| `config.py` | → `app/config.py` (mismo propósito — leer variables de entorno — pero reescrito como una clase `Settings` en vez de variables sueltas a nivel de módulo; se le agregó `root_path` y `cookie_secure`). |

No se pudo verificar un archivo `security.py` ni `sedes.py`/`grafo.py` sueltos en `origin/develop` porque no existen ahí — esos nombres de módulo son productos nuevos de la reorganización, no renombres directos.

## Carpetas/archivos nuevos que no existen en `origin/develop`

- **`app/salas/`** (`__init__.py`, `crud.py`, `router.py`, `schemas.py`) — sistema de gestión de Salas por piso, construido enteramente en esta sesión. Sin equivalente en la estructura plana.
- **`app/zonas/`** (`__init__.py`, `crud.py`, `router.py`, `schemas.py`) — sistema de Zonas (contornos de edificio, zonas seguras) y catálogo de Características, construido enteramente en esta sesión. Sin equivalente en la estructura plana.
- **`app/sedes/schemas.py`**, **`app/grafo/schemas.py`** — no tienen contraparte en el `schemas.py` viejo (que solo cubría auth); son schemas nuevos para ordenar cada dominio dentro del paquete.
- Detalle de qué cambió a nivel de funcionalidad (no solo de ubicación) está en `CHANGELOG.md` y `CAMBIOS-JSON-SNAPSHOT.md` — este documento es solo el mapa de "dónde quedó cada archivo", no repite ese contenido.
