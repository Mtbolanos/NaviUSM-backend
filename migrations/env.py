"""Configuracion de entorno de Alembic para NaviUSM.

Dos decisiones deliberadas, documentadas aca porque no son obvias:

1. La URL de conexion se toma de ``app.config.settings`` (que ya hace ``load_dotenv()``),
   no de ``alembic.ini``. Asi las credenciales viven en un solo lugar --el ``.env``, que esta
   en ``.gitignore``-- y el mismo comando funciona desde el venv del host y desde dentro
   del contenedor, donde ``DATABASE_URL`` apunta a otro host.

2. ``target_metadata`` es None A PROPOSITO, y ``--autogenerate`` esta bloqueado.
   El esquema tiene 16 tablas y ``app/models.py`` declara solo 9 modelos ORM: las 7 tablas
   del grafo y las zonas (nodo, arista, poi, zona, zona_caracteristica, ruta_evacuacion,
   ruta_evacuacion_arista) se acceden con SQL crudo porque el proyecto no usa GeoAlchemy2.
   Autogenerate compara los modelos contra la base y concluye que esas 7 tablas "sobran":
   generaria una migracion que BORRA el grafo completo.

   Ademas, casi nada de lo que este proyecto necesita expresar es autogenerable
   (constraints EXCLUDE con GiST, CHECK con funciones PostGIS, RLS, triggers), asi que la
   automatizacion no compraria mucho ni aun con los modelos completos.

   Las migraciones se escriben a mano. Ver docs/MIGRACIONES.md.
"""

from logging.config import fileConfig

from sqlalchemy import engine_from_config, pool

from alembic import context

from app.config import settings

config = context.config

# La URL viene de la configuracion de la app, no del .ini
if not settings.database_url:
    raise RuntimeError(
        "DATABASE_URL esta vacio. Alembic la toma de app.config.settings, que lee el .env. "
        "Copia .env.example a .env y define DATABASE_URL antes de correr migraciones."
    )
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# Ver el punto 2 del docstring: esto NO se completa.
target_metadata = None


_MENSAJE_AUTOGENERATE = (
    "--autogenerate esta deshabilitado en este proyecto.\n"
    "Motivo: app/models.py declara 9 modelos para 16 tablas; las 7 tablas del grafo y\n"
    "las zonas no tienen modelo ORM, y autogenerate generaria una migracion que las BORRA\n"
    "(nodo, arista, poi, zona, zona_caracteristica, ruta_evacuacion,\n"
    "ruta_evacuacion_arista).\n\n"
    "Escribe la migracion a mano:\n"
    "    alembic revision -m \"descripcion del cambio\"\n\n"
    "Detalle en docs/MIGRACIONES.md."
)


def _autogenerate_pedido() -> bool:
    """True si el comando se invoco con --autogenerate."""
    return bool(getattr(config.cmd_opts, "autogenerate", False))


def _bloquear_autogenerate(context_, revision, directives):
    """Guard real, no un comentario: falla antes de escribir el archivo de migracion.

    Solo aborta cuando se pidio --autogenerate. Alembic invoca este hook tambien en un
    ``alembic revision`` normal, que si esta permitido.
    """
    if _autogenerate_pedido():
        raise RuntimeError(_MENSAJE_AUTOGENERATE)


# Primera linea de defensa: si se pidio --autogenerate, abortar apenas carga el entorno.
if _autogenerate_pedido():
    raise RuntimeError(_MENSAJE_AUTOGENERATE)


def run_migrations_offline() -> None:
    """Genera el SQL sin conectarse a la base (``alembic upgrade head --sql``)."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        process_revision_directives=_bloquear_autogenerate,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Aplica las migraciones contra la base."""
    connectable = engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    with connectable.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            process_revision_directives=_bloquear_autogenerate,
        )

        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
