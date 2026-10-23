# Pruebas automatizadas

Las pruebas usan `pytest` y se dividen en dos grupos:

| Carpeta | Qué verifica | Necesita base de datos |
|---|---|---|
| `tests/unit` | Reglas de negocio del grafo (pisos, conectores, pesos, Gestión de Edificios), contraseñas, cookie de sesión, token de la app móvil, API keys y buscador de lugares (servicio externo simulado) | No |
| `tests/integration` | Endpoints completos contra PostgreSQL + PostGIS: login y sesión, aislamiento entre organizaciones, publicación versionada y control de concurrencia, Gestión de Edificios, contorno de sedes y API móvil | Sí |

## Ejecutar

```bash
pip install -r requirements-dev.txt
pytest                      # sin TEST_DATABASE_URL corren solo las unitarias; las de integración se omiten
```

Para las de integración se necesita una base **de prueba** con el schema aplicado. El nombre de la base debe
contener `test`: las pruebas vacían sus tablas antes de cada caso, así que nunca debe apuntar a producción ni al
espejo de desarrollo.

```bash
createdb -U naviusm naviusm_test
grep -v '\\restrict\|\\unrestrict' schema_actualizado.sql | sed "s/OWNER TO postgres/OWNER TO naviusm/g" \
  | psql -U naviusm -d naviusm_test -v ON_ERROR_STOP=1 -q
TEST_DATABASE_URL=postgresql://naviusm:<clave>@localhost:5432/naviusm_test pytest -ra
```

## Integración continua

`.github/workflows/tests.yml` ejecuta todas las pruebas en cada push a `main`, `develop`, `feature/**`,
`release/**` y `hotfix/**`, y en los pull requests hacia `main` y `develop`, con un contenedor
`postgis/postgis:16-3.4` (la misma imagen de `docker-compose.yml`). El reporte JUnit queda como artefacto
`reporte-pruebas` en cada ejecución.

## Casos marcados como `xfail`

Un `xfail` estricto documenta un defecto conocido: la prueba describe el comportamiento esperado y falla mientras
el defecto exista. Cuando se corrige, el `xfail` pasa a "XPASS" y la ejecución falla para recordar quitar la marca.

- `test_solo_se_conservan_las_dos_ultimas_versiones`: la retención de snapshots conserva 3 versiones en vez de 2.
