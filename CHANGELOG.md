# Cambios desde el último commit (`4d22e46`)

_2026-09-02_

Todo lo de acá está sin commitear todavía — es el resumen de una sesión larga de trabajo sobre Docker, el sistema de zonas/edificios, y salas. Lo dejo agrupado por tema, no por orden cronológico, para que sea más fácil de revisar.

## 1. Dockerización del backend

Antes no había forma reproducible de levantar el proyecto — dependía de `setup_db.sh`, un script solo para Arch Linux (usa `pacman`) que instalaba Postgres directo en el host.

**Archivos nuevos:**
- `Dockerfile` — imagen `python:3.14-slim`, copia `app/`, `static/`, `templates/`, `seed.py`.
- `docker-compose.yml` — dos servicios:
  - `db`: `postgis/postgis:16-3.4` (no `postgres` puro — el schema exige la extensión), con volumen nombrado `naviusm-db-data` para persistencia y healthcheck `pg_isready`.
  - `backend`: monta `./app` como volumen (hot-reload con `uvicorn --reload`), depende de que `db` esté healthy, expone `8000:8000`.
- `docker/init/01-init.sh` — se monta en `/docker-entrypoint-initdb.d/`; aplica `schema_actualizado.sql` reproduciendo la misma transformación que hacía `setup_db.sh` (recorta las líneas `\restrict`/`\unrestrict` del dump y reescribe `OWNER TO postgres` → `OWNER TO naviusm`).
- `docker/dev-up.sh` — script que corre `docker compose up --build -d` y de una vez muestra `ps` + logs de `db`/`backend`; pensado para correr con `sudo` en una sola línea.
- `.dockerignore` — excluye `venv/`, `__pycache__/`, `.env`, `.git`.

**Cambios relacionados:**
- `app/config.py` / `app/main.py`: `root_path` de FastAPI pasa de estar hardcodeado (`"/naviusm"`) a leerse de una variable de entorno `ROOT_PATH` (default `""`). Así el login funciona directo en `localhost:8000` sin necesitar un reverse proxy delante; en producción real (detrás de nginx) se setea `ROOT_PATH=/naviusm` sin tocar código.
- `.env.example`: valores que realmente funcionan out-of-the-box (antes tenía un placeholder de `SECRET_KEY` que ni siquiera era una Fernet key válida), y se agrega `ROOT_PATH=`.
- `templates/mobile.html`: igual que `admin.html`, tenía `/naviusm/static/...` hardcodeado en los `<link>`/`<script>` — rutas absolutas que rompían sin el proxy. Se sacó el prefijo.
- `static/js/mobile.js`: los tiles del mapa venían de `basemaps.cartocdn.com`, que ahora exige API key y devolvía un tile con el aviso "API KEY REQUIRED" pegado encima en vez del mapa real. Se cambió a los tiles estándar de OpenStreetMap (gratis, sin key — coherente con que el proyecto ya declara "Leaflet + OSM" como su stack).

**Bugs de backend encontrados y arreglados en el camino** (preexistentes, no introducidos esta sesión, solo nunca se habían disparado):
- `app/grafo/crud.py::publish_graph_data` — la limpieza de huérfanos (`DELETE ... WHERE id != ALL(:param)`) comparaba `uuid <> text` sin cast, lo que revienta apenas se publica un grafo con datos reales. Se corrigió con `CAST(:param AS uuid[])` (nota: `id != ALL(:param::uuid[])` no funciona — SQLAlchemy interpreta mal el `::` pegado al nombre del bind param).
- `static/js/admin.js` — `renderBuildingListModal()` se llamaba en `loadGraph()` sin estar definida en ningún lado (función de una feature que nunca se terminó); reventaba silenciosamente el `try/catch` de `loadFromServer()`, así que el editor nunca dibujaba nada. Se sacó la llamada.
- `static/js/admin.js` — `nextEdgeId` se leía sin haber sido declarada nunca (`let`). Con datos reales (ids que empiezan con dígito, ej. `418bd183-...`) el `parseInt` de la migración de ids viejos alcanzaba a leerla y tiraba `ReferenceError`. Se declaró en el bloque de estado.

## 2. Sistema de Zonas y Edificios (nuevo, de punta a punta)

### Schema
Tres tablas nuevas en `schema_actualizado.sql`:
- **`caracteristica`** — catálogo de etiquetas (`codigo`, `nombre`, `color_hex`), sembrado en `seed.py` con 4 filas: `zona_segura`, `zona_silenciosa`, `accesible_silla_ruedas`, `contorno_edificio`.
- **`zona`** — polígono (`geometry(Polygon,4326)`), `edificio_id` nullable (el contorno de un edificio es una `zona` cuyo `edificio_id` apunta a ese edificio — no hace falta una tabla aparte), `color_hex` propio (nullable — si no se define, cae al color de la característica). (La primera versión tenía además un campo `piso`, pensado para el contorno del edificio — se sacó porque esa función ya vive en `Edificio.piso_min`/`piso_max` y nunca se construyó UI para usarlo en `zona`.)
- **`zona_caracteristica`** — join, una zona puede llevar más de una etiqueta.

`zona`/`zona_caracteristica` no tienen modelo ORM (mismo criterio que `nodo`/`arista`/`poi`: tablas con geometría se manejan con SQL crudo). `caracteristica` sí es ORM, por ser una tabla simple sin geometría.

### Backend — `app/zonas/` (paquete nuevo)
- `crud.py::upsert_zonas` — mismo patrón de upsert + limpieza de huérfanos que ya usa `publish_graph_data` para nodos/aristas/edificios.
- `router.py::GET /admin/api/caracteristicas` — devuelve el catálogo.
- Integrado en `app/grafo/crud.py::publish_graph_data`: agrega el paso 7 (`upsert_zonas(...)`) dentro de la misma transacción de publish, leyendo `payload.get("zonas", [])`. El endpoint público de snapshot no cambió — ya devolvía el payload completo tal cual.

### Frontend — editor NaviUSM Studio (`static/js/admin.js`, `templates/admin.html`)
Se construyó todo un modo de dibujo a mano (no hay Leaflet-geoman en el proyecto):

- **Dos modos de mapa separados**: "Zonas" (zonas seguras — color verde fijo `#1f7a5c`, sin selector) y "Edificios" (contornos — color azul-gris fijo `#3b6e8f`, sin selector, líneas rectas sin suavizar). Reemplazan al modo único "Zona" del primer intento.
- Click en el mapa agrega vértices como marcadores arrastrables (ajustables en vivo mientras se dibuja); un botón "Guardar" (deshabilitado hasta 3+ vértices) construye el GeoJSON final.
- **Suavizado de Chaikin** (`smoothPolygon`, corner-cutting, 2 iteraciones) aplicado solo al modo Zonas — las zonas seguras quedan con curvas orgánicas; los contornos de edificio quedan con esquinas rectas tal cual se clickean (los edificios son rectangulares, no debían suavizarse).
- **Editar una zona/edificio ya guardado**: click sobre una zona existente (en su mismo modo) carga nombre/edificio asociado en el panel para editar — el guardado hace update in-place (mismo `id`, `upsert_zonas` ya resuelve por `ON CONFLICT (id) DO UPDATE`, no por nombre). No incluye reshape de vértices todavía (eso queda para más adelante).
- Borrar sigue funcionando en modo "Borrar" clickeando la forma.

### Importación automática desde OpenStreetMap
En vez de dibujar cada edificio a mano, se consultó la API pública de Overpass por `building=*`/`landuse`/`leisure` alrededor del centro de la sede — OSM ya tiene geometría real (agrimensura) de casi todo el campus, con nombre. Se generaron y publicaron automáticamente:
- **16 contornos de edificio**: A, C1, C2, D (dos bloques), E, F, G, J, M, P, R, S, U, Gimnasio, FabLab — de los cuales A/G/R/U quedaron vinculados al nodo de edificio real que ya existía en el grafo.
- **3 zonas seguras**: Patio Central, Multicancha, Cancha Basketball.
- Se dejaron afuera "Edificio H" y "Edificio B" (existen en el grafo pero OSM no tenía geometría con ese nombre exacto) y nombres ambiguos ("Torre A/B") — conservador, para no adivinar.
- El JSON de respaldo del grafo completo (bajado de un compañero de equipo para restaurar datos de prueba) quedó guardado en `fixtures/sede-vina-del-mar-snapshot.json`.

## 3. Tabla `sala` (gestión de salas por piso, sin geometría)

Decisión de diseño (pensada desde la tesina de BD del usuario): una sala **no** debía forzarse a ser un `nodo` geolocalizado solo para poder catalogarla — eso mezclaba "inventario de salas" con "punto ruteable". Se separó en una tabla propia:

```sql
CREATE TABLE sala (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    edificio_id uuid NOT NULL REFERENCES edificio(id) ON DELETE CASCADE,
    organizacion_id uuid NOT NULL REFERENCES organizacion(id) ON DELETE CASCADE,
    piso integer NOT NULL,
    nombre varchar(255) NOT NULL
);
CREATE INDEX idx_sala_edificio_piso ON sala (edificio_id, piso);
```

Sin índice GiST (no tiene geometría, no lo necesita) — el índice compuesto `(edificio_id, piso)` calza exacto con el patrón de acceso real ("salas del piso N del edificio X"). (La primera versión también tenía un `nodo_id` nullable pensado para linkear la sala a un nodo del mapa el día que alguien la ubicara — se sacó porque ningún schema/CRUD llegó a usarlo.)

**Backend — `app/salas/` (paquete nuevo):** CRUD completo (`GET/POST/PATCH/DELETE`), con su propio ciclo de vida — **no** pasa por `publish_graph_data` ni viaja en el snapshot público, porque el usuario no quiere las salas visibles en el mapa (ni con toggle) todavía.

**Frontend:** dentro del modo "Edificios", una sección "Pisos y Salas" — selecciona un edificio, edita su rango de pisos (`piso_min`/`piso_max`, mismo mecanismo que ya existía), tabs por piso, y una lista simple de salas por piso con agregar/borrar.

## Archivos nuevos

```
app/zonas/{__init__,crud,router,schemas}.py
app/salas/{__init__,crud,router,schemas}.py
fixtures/sede-vina-del-mar-snapshot.json
```

El setup de Docker (`Dockerfile`, `docker-compose.yml`, `docker/`, `.dockerignore`) se armó igual para poder levantar y probar el proyecto, pero quedó fuera de git (`.gitignore`) — no es parte del alcance de esta sesión, cada quien decide cómo levanta su entorno local.

## 4. Limpieza de plomería muerta (`Sala.nodo_id`, `Zona.piso`)

Revisión posterior encontró dos campos cableados de punta a punta (modelo → schema → CRUD → frontend) pero nunca usados por ninguna UI real: `Sala.nodo_id` (pensado para linkear una sala a un nodo del mapa) y `piso`/`floor` en `Zona` (pensado para el contorno del edificio, función que ya vive en `Edificio.piso_min`/`piso_max`). Se sacaron por completo de `app/models.py`, `schema_actualizado.sql`, `app/zonas/crud.py` y `static/js/admin.js`, verificando que ningún otro consumidor los referenciara (el único otro uso de `nodo_id` en el repo es el de la tabla `poi`, no relacionado).

## Pendiente / decisiones abiertas para después
- Reshape de vértices de una zona/edificio ya guardado (hoy solo se edita nombre/edificio asociado).
- Mostrar las salas en el mapa (o un toggle) — hoy son puramente metadata de gestión.
- `ruta_evacuacion`/`ruta_evacuacion_arista` (del schema original) siguen sin uso — pendiente decidir si el producto reemplaza rutas de evacuación estáticas por ruteo dinámico a zona segura, o si conviven ambas.
- No hay políticas RLS todavía (las tablas tienen `ENABLE ROW LEVEL SECURITY` pero cero `CREATE POLICY`) — funciona hoy porque la app conecta como dueño de las tablas; es un gap conocido antes de un despliegue multi-tenant real.
