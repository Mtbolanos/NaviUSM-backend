# Migraciones de esquema (Alembic)

El esquema de la base de datos se versiona con Alembic. Cada cambio es un archivo en
`migrations/versions/`, numerado y reversible, y la base registra en qué revisión va.

Antes de esto el esquema era `schema_actualizado.sql` (un `pg_dump`, o sea una foto del estado
final) más `migracion_zonas_salas.sql` aplicado a mano. El problema no era que no funcionara: era
que no se podía responder "cómo era el esquema cuando corrí este experimento", ni garantizar que
dos personas llegaran al mismo estado.

## Uso diario

```bash
# Poner la base al día
./venv/bin/alembic upgrade head

# Ver en qué revisión está la base
./venv/bin/alembic current

# Ver el historial completo
./venv/bin/alembic history --verbose

# Crear una migración nueva (SIEMPRE sin --autogenerate, ver abajo)
./venv/bin/alembic revision -m "agrega constraint de unicidad de nodo"
```

Desde dentro del contenedor es lo mismo sin el prefijo del venv:

```bash
docker compose exec backend alembic upgrade head
```

La URL de conexión no está en `alembic.ini`: `migrations/env.py` la toma de
`app.config.settings`, que lee `DATABASE_URL` del `.env`. Así no se duplican credenciales, no
entran a git, y el mismo comando sirve en el host y en el contenedor.

## `--autogenerate` está deshabilitado. A propósito

**No lo habilites sin leer esto.**

Autogenerate compara los modelos ORM contra la base y escribe la diferencia. El problema es que
en este proyecto los modelos **no describen la base completa**: el esquema tiene 17 tablas y
`app/models.py` declara 10 modelos. Las tablas del grafo y de zonas —`nodo`, `arista`, `poi`, `zona`,
`zona_caracteristica`, `ruta_evacuacion`, `ruta_evacuacion_arista`— se acceden con SQL crudo
porque el proyecto no usa GeoAlchemy2.

Entonces autogenerate ve 17 tablas en la base y 10 en el código, concluye que sobran 7, y
**genera una migración que borra el grafo completo.**

`migrations/env.py` lo bloquea con una excepción explícita, antes de escribir archivo alguno.

Y hay una segunda razón, independiente: casi nada de lo que este proyecto necesita expresar es
autogenerable. Los constraints `EXCLUDE` con GiST, los `CHECK` con funciones PostGIS, el RLS y los
triggers se escriben a mano de todas formas. Autogenerate detecta tablas, columnas e índices
simples; el resto no.

Si algún día se completan los 7 modelos faltantes (con GeoAlchemy2), se puede reevaluar.

## Cómo escribir una migración

1. `./venv/bin/alembic revision -m "descripcion corta"` — crea el archivo con la cadena de
   revisiones ya enlazada.
2. Escribe `upgrade()` y `downgrade()`. Para DDL crudo —bloques `DO $$`, constraints de PostGIS—
   usa `op.get_bind().exec_driver_sql(...)`, que no pasa el SQL por el parser de bind params de
   SQLAlchemy.
3. `downgrade()` tiene que revertir de verdad. Si no se puede, lanza `NotImplementedError` con el
   motivo, como hace la 0001.
4. Prueba el viaje de ida y vuelta: `alembic upgrade head`, `alembic downgrade -1`,
   `alembic upgrade head`. El estado final debe ser idéntico.
5. Verifica contra la base que el cambio quedó como esperabas antes de commitear.

## El historial

| Revisión | Qué hace |
|---|---|
| `0001` | Baseline. No-op: representa el esquema base de 10 tablas tal como lo deja `schema_actualizado.sql` |
| `0002` | Las 4 tablas de zonas y salas, las 3 columnas de contacto de `poi`, sus índices, RLS y el catálogo inicial. Es el contenido de `migracion_zonas_salas.sql` |
| `0003` | `arista.es_escalera` (boolean, default false) |
| `0004` | Tabla `api_key` e índice `idx_api_key_organizacion`. Reconstruida del bloque final de `schema_actualizado.sql` (el `migraciones/002_api_keys.sql` que cita no existe en el repo) |
| `0005` | Tabla `edificio_piso` (con RLS), `edificio.piso_acceso`, conversión de `piso_min`/`piso_max` a filas de `edificio_piso` y borrado de esas columnas. Es `migraciones/003_edificio_pisos.sql` sin el `DROP TABLE sala` |
| `0006` | Tabla `conector` (con RLS e índice) y `nodo.conector_id` con su índice. Es `migraciones/004_conectores.sql` |
| `0007` | `sede.contorno` (Polygon 4326, opcional). Es `migraciones/005_sede_contorno.sql` |
| `0008` | Borra la tabla `sala` (redundante con `poi`). Es el final de `migraciones/003_edificio_pisos.sql` |
| `0009` | Tabla `publicacion` (con RLS e índice `idx_publicacion_sede_fecha`): una fila por ejecución del publish (`POST /publish` y `PATCH /edificios`), publicada o rechazada. Aparte de `snapshot` para sobrevivir a la retención. Nueva, no viene de `migraciones/`; ya está también en `schema_actualizado.sql` |

Las 0004–0008 portan a la cadena cambios que se aplicaron a mano con los `.sql` de `migraciones/`.
Son idempotentes (`IF [NOT] EXISTS`, y la conversión de pisos solo corre si `piso_min` existe), y
tienen `downgrade()` real. Los downgrade de 0005 y 0008 son con pérdida: 0005 vuelve al rango
`piso_min`/`piso_max` (menor y mayor piso registrado) y pierde nombres de piso, huecos y
`piso_acceso`; 0008 recrea `sala` vacía.

Verificado sobre bases desechables: el dump de `191c032` + `upgrade head` da exactamente el mismo
`pg_dump --schema-only` que el `schema_actualizado.sql` actual, y `downgrade 0003` devuelve
exactamente el esquema de `191c032`. Con la 0009 se repitió: `191c032` + `upgrade head` = el
`schema_actualizado.sql` con `publicacion`; `downgrade 0008` = el `schema_actualizado.sql` anterior,
y `stamp 0008` + `upgrade head` sobre el dump anterior tampoco deja diferencias (idempotente).

La 0009 es la primera revisión que no porta un `.sql` aplicado a mano: es un cambio nuevo. Por eso
el `schema_actualizado.sql` se actualizó en el mismo commit, con los bloques tal como los emite
`pg_dump` (insertados en orden, no agregados al final), para que una instalación nueva siga
quedando en `head`.

## Bases que ya existían antes de esta cadena

Depende de en qué estado esté la base. **Respaldar antes** en todos los casos
(`pg_dump -Fc`).

**Producción (y cualquier base con `migraciones/003`–`005` ya aplicadas a mano, sin
`alembic_version`):** el esquema está en `0008`; solo falta que Alembic lo sepa, y después aplicar
lo que vino de verdad nuevo (la 0009, que crea `publicacion`).

```bash
# 1. Comprobar que el esquema es el de 0008 (no debe haber diferencias): compararlo con el de una
#    base desechable creada con schema_actualizado.sql y llevada a 0008 (stamp head + downgrade 0008)
pg_dump --schema-only --no-owner --no-privileges -d naviusm > actual.sql
# 2. Registrar la revisión, sin ejecutar nada
alembic stamp 0008
# 3. Aplicar lo nuevo
alembic upgrade head
```

**Base creada con el `schema_actualizado.sql` actual** (ya trae `publicacion`): está en `head`;
`alembic stamp head`.

Se usa `stamp` y no `upgrade head` aunque las migraciones sean idempotentes, porque `upgrade head`
sí escribe algo en una base que ya está al día: la 0002 vuelve a sembrar el catálogo de
`caracteristica` si falta alguna fila, la 0005 inserta el piso de acceso en todo edificio que no
tenga pisos, y la 0002 crea `sala` para que la 0008 la borre. Con `stamp` no se toca nada.

**Base anterior a `migraciones/003`** (tiene `piso_min`/`piso_max`, sin `alembic_version`):
`alembic upgrade head`. Convierte los rangos de piso a `edificio_piso` y deja el esquema en `head`.

**Base que ya tiene `alembic_version`** (en `0002` o `0003`): `alembic upgrade head`.

Si `alembic stamp` se hizo sobre una base que en realidad no estaba al día, el error no se ve
hasta que falle una consulta: por eso el paso 1.

### Por qué el baseline es un no-op

El esquema base ya existe en las bases en uso, y en una base nueva lo crea
`docker/init/01-init.sh` aplicando el dump antes de que Alembic entre en escena. Re-declarar 822
líneas de dump como código de migración solo agregaría una segunda definición del mismo esquema,
que se puede desincronizar de la primera.

La consecuencia práctica: **`alembic upgrade head` funciona desde cualquier punto de partida**,
porque todas las revisiones son idempotentes.

- Base con el esquema base (10 tablas): crea `alembic_version`, pasa por 0001 sin hacer nada, y
  0002 le crea las 4 tablas que le faltan; de ahí en adelante, cada revisión aplica lo suyo.
- Base creada con el dump completo actual (17 tablas): ninguna revisión cambia el esquema (la 0002
  crea `sala` y la 0008 la borra). Aun así, para producción se recomienda `alembic stamp head`;
  ver «Bases que ya existían antes de esta cadena».

## Los `.sql` antiguos se conservan

`schema_actualizado.sql` sigue siendo el baseline que aplica `docker/init/01-init.sh`, y
`migracion_zonas_salas.sql` y `migraciones/003`–`005` quedan como referencia histórica de dónde
salieron las revisiones 0002 y 0004–0008. Una base creada con el `schema_actualizado.sql` actual
ya está en `head`: `alembic stamp head`. No
los borres: de ahí en adelante, sin embargo, **todo cambio de esquema va como migración**, no como
edición del dump.

Ojo con `.gitignore`: ignora `*.sql` salvo esos dos archivos. Si alguna vez agregas un `.sql`
dentro de `migrations/`, quedaría fuera de git en silencio — por eso las migraciones llevan el SQL
embebido en el `.py`.
