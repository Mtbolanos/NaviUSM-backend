# Base de datos

PostgreSQL 16 + PostGIS (imagen `postgis/postgis:16-3.4`). El esquema completo para instalaciones nuevas está en
`schema_actualizado.sql` (lo aplica `docker/init/01-init.sh` al crear el volumen). Las bases existentes se actualizan
con los archivos de `migraciones/`, en orden.

## Fuente de verdad

- **El snapshot es la fuente de verdad del mapa.** El editor publica un JSON completo (`snapshot.payload`) y la app
  móvil lo descarga tal cual para calcular rutas sin conexión. Las tablas del grafo (`edificio`, `edificio_piso`,
  `nodo`, `poi`, `arista`, `zona`, `zona_caracteristica`) se reescriben desde ese JSON en cada publicación, para
  consultas y para pgRouting.
- Cada publicación crea una versión nueva de `snapshot` por sede y conserva solo las 2 más recientes.
- Publicar es una sola transacción: bloquea la fila de la sede (`SELECT ... FOR UPDATE`), valida, escribe el snapshot
  y reemplaza las tablas del grafo de esa sede. Si algo falla, no queda nada a medias.

## Multi-organización

Casi todas las tablas tienen `organizacion_id` (FK a `organizacion` con `ON DELETE CASCADE`). La API filtra siempre
por la organización del usuario o de la API key, y el publish rechaza (409) IDs que pertenezcan a otra organización
o sede. Las tablas tienen RLS habilitado sin políticas: la aplicación se conecta como dueña de las tablas.

## Tablas

### Organización y acceso

| Tabla | Columnas | Notas |
|---|---|---|
| `organizacion` | `id`, `nombre`, `slug` (único), `created_at` | Cliente (por ejemplo, una universidad). |
| `usuario` | `id`, `organizacion_id`, `email` (único), `password_hash` (bcrypt), `rol`, `is_active`, `created_at`, `last_login` | Usuarios del panel. |
| `api_key` | `id`, `organizacion_id`, `nombre`, `prefijo`, `key_hash` (SHA-256, único), `created_by` (FK a `usuario`, `SET NULL`), `created_at`, `expires_at`, `last_used_at`, `revoked_at` | Keys de la app móvil. Solo se guarda el hash. |

### Sedes y versiones del mapa

| Tabla | Columnas | Notas |
|---|---|---|
| `sede` | `id`, `organizacion_id`, `nombre`, `latitud`, `longitud`, `zoom_defecto`, `created_at` | Campus. Borrar una sede borra en cascada todo su mapa. |
| `snapshot` | `id`, `sede_id`, `organizacion_id`, `payload` (jsonb), `version`, `published_at` | Mapa publicado. `version` crece de a 1 por sede. Formato del payload: `docs/CAMBIOS-JSON-SNAPSHOT.md`. |

### Grafo (se reescribe en cada publicación)

| Tabla | Columnas | Notas |
|---|---|---|
| `edificio` | `id`, `sede_id`, `organizacion_id`, `nombre`, `piso_acceso` (default 1) | `id` = id del nodo `building` del snapshot. `piso_acceso`: piso a nivel de la calle. |
| `edificio_piso` | **PK (`edificio_id`, `numero`)**, `organizacion_id`, `nombre` (varchar 100, opcional) | Un registro por piso. Los números son enteros únicos por edificio (negativos = subterráneos). Sin `nombre` se muestra "Piso N" / "Subterráneo N". Se reemplazan completos al publicar. |
| `nodo` | `id`, `sede_id`, `organizacion_id`, `geom` (PointZ 4326; Z = piso), `piso`, `tipo`, `edificio_id` (null = exterior), `conector_id` (FK a `conector`, `SET NULL`), `gid` (serial, único), `created_at` | Puntos del grafo. `gid` es el id entero que usa pgRouting. `conector_id` marca los puntos de un conector. |
| `conector` | `id`, `sede_id`, `edificio_id` (FK, cascade), `organizacion_id`, `tipo` (check: `escalera`, `ascensor`, `rampa`), `nombre` (opcional) | Escalera, ascensor o rampa entre pisos de un edificio. Sus puntos son los nodos con ese `conector_id`. Ascensor: un punto por piso, unidos de piso en piso. Escalera/rampa: tramos de un punto de un piso a otro punto del piso siguiente, más descansos dentro de un piso; las aristas de los tramos de una escalera llevan `es_escalera = true`. |
| `poi` | `id`, `nodo_id` (único), `organizacion_id`, `nombre`, `categoria` (= tipo del nodo), `horario`, `descripcion`, `link_derivacion` | Datos de los nodos que no son puntos de ruta. |
| `arista` | `id`, `origen_id`, `destino_id` (FK a `nodo`, cascade; check origen <> destino), `organizacion_id`, `distancia` (= `weight` del snapshot), `es_escalera`, `es_bidireccional`, `es_accesible`, `source`, `target` | Conexiones. `source`/`target` se rellenan con `nodo.gid` para pgRouting. La ruta accesible evita `es_escalera = true`. |
| `zona` | `id`, `sede_id`, `organizacion_id`, `edificio_id` (null = exterior), `nombre`, `geom` (Polygon 4326), `color_hex` | Contornos de edificio y zonas (seguras, etc.). |
| `caracteristica` | `id`, `codigo` (único), `nombre`, `color_hex` | Catálogo de etiquetas de zona: `zona_segura`, `contorno_edificio`, `zona_silenciosa`, `accesible_silla_ruedas` (sembrado por `seed.py`). |
| `zona_caracteristica` | `zona_id`, `caracteristica_id` | Etiquetas de cada zona (`tags` del snapshot). |

### Reservadas (aún sin uso en la aplicación)

| Tabla | Columnas |
|---|---|
| `ruta_evacuacion` | `id`, `sede_id`, `organizacion_id`, `nombre`, `tipo_emergencia` |
| `ruta_evacuacion_arista` | `ruta_evacuacion_id`, `arista_id`, `orden` |

## Relaciones y borrado en cascada

```
organizacion ─┬─ usuario ── api_key.created_by (SET NULL)
              ├─ api_key
              └─ sede ─┬─ snapshot
                       ├─ edificio ─┬─ edificio_piso
                       │            ├─ conector ── nodo.conector_id (SET NULL)
                       │            ├─ nodo.edificio_id
                       │            └─ zona.edificio_id
                       ├─ nodo ─┬─ poi
                       │        └─ arista (origen_id / destino_id) ── ruta_evacuacion_arista
                       ├─ zona ── zona_caracteristica ── caracteristica
                       └─ ruta_evacuacion ── ruta_evacuacion_arista
```

Todas las FK son `ON DELETE CASCADE`, salvo `api_key.created_by` y `nodo.conector_id` (`SET NULL`).

## Reglas que valida el publish

- IDs en formato UUID y pertenecientes a la sede y organización (409 si no).
- Las aristas solo unen nodos del mismo payload (409).
- Cada edificio tiene al menos un piso, sin números repetidos, y su `acceso` es uno de sus pisos (422).
- Todo nodo dentro de un edificio está en un piso que existe en ese edificio (422).
- Cada conector tiene un tipo válido y pertenece a un edificio del mapa; sus puntos están en ese edificio (422).
- Control de versión: si el cliente envía `X-Base-Version` y ya no es la última versión publicada, 409.

## Migraciones

| Archivo | Cambio |
|---|---|
| `migracion_zonas_salas.sql` | Histórica: zonas y la antigua tabla `sala` (eliminada en la 003). |
| `migraciones/002_api_keys.sql` | Tabla `api_key`. |
| `migraciones/003_edificio_pisos.sql` | Tabla `edificio_piso`, columna `edificio.piso_acceso`, conversión de `piso_min`/`piso_max` (se eliminan) y eliminación de `sala`. Idempotente. |
| `migraciones/004_conectores.sql` | Tabla `conector` y columna `nodo.conector_id`. Idempotente. |

Aplicar una migración (respaldar antes):

```
docker compose exec -T db pg_dump -U naviusm -d naviusm -Fc > respaldo.dump
docker compose exec -T db psql -U naviusm -d naviusm -v ON_ERROR_STOP=1 < migraciones/004_conectores.sql
```

Toda migración nueva se refleja también en `schema_actualizado.sql` y en este documento.
