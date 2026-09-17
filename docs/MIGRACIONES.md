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
en este proyecto los modelos **no describen la base completa**: el esquema tiene 14 tablas y
`app/models.py` declara 7 modelos. Las tablas con geometría —`nodo`, `arista`, `poi`, `zona`,
`zona_caracteristica`, `ruta_evacuacion`, `ruta_evacuacion_arista`— se acceden con SQL crudo
porque el proyecto no usa GeoAlchemy2.

Entonces autogenerate ve 14 tablas en la base y 7 en el código, concluye que sobran 7, y
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

### Por qué el baseline es un no-op

El esquema base ya existe en las bases en uso, y en una base nueva lo crea
`docker/init/01-init.sh` aplicando el dump antes de que Alembic entre en escena. Re-declarar 822
líneas de dump como código de migración solo agregaría una segunda definición del mismo esquema,
que se puede desincronizar de la primera.

La consecuencia práctica es buena: **`alembic upgrade head` funciona en los dos escenarios y no
hace falta `alembic stamp`.**

- Base con el esquema base (10 tablas): crea `alembic_version`, pasa por 0001 sin hacer nada, y
  0002 le crea las 4 tablas que le faltan.
- Base creada con el dump completo (14 tablas): pasa por 0001 sin hacer nada, y 0002 tampoco hace
  nada porque es idempotente (`IF NOT EXISTS` / `ON CONFLICT`).

## Los `.sql` antiguos se conservan

`schema_actualizado.sql` sigue siendo el baseline que aplica `docker/init/01-init.sh`, y
`migracion_zonas_salas.sql` queda como referencia histórica de dónde salió la revisión 0002. No
los borres: de ahí en adelante, sin embargo, **todo cambio de esquema va como migración**, no como
edición del dump.

Ojo con `.gitignore`: ignora `*.sql` salvo esos dos archivos. Si alguna vez agregas un `.sql`
dentro de `migrations/`, quedaría fuera de git en silencio — por eso las migraciones llevan el SQL
embebido en el `.py`.
