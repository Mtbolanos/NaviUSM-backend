# Creación inicial de datos en BD
from pydantic import EmailStr, Field, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.database import SessionLocal
from app.models import Caracteristica, Organizacion, Usuario
from app.security import BCRYPT_MAX_BYTES, get_hash_password, password_too_long

CARACTERISTICAS = [
    ("zona_segura", "Zona segura", "#1f7a5c"),
    ("zona_silenciosa", "Zona silenciosa", "#5c4d99"),
    ("accesible_silla_ruedas", "Accesible en silla de ruedas", "#b5651d"),
    ("contorno_edificio", "Contorno de edificio", "#3b6e8f"),
]


def seed_caracteristicas(db):
    existentes = {c.codigo for c in db.query(Caracteristica.codigo).all()}
    nuevas = [
        Caracteristica(codigo=codigo, nombre=nombre, color_hex=color_hex)
        for codigo, nombre, color_hex in CARACTERISTICAS
        if codigo not in existentes
    ]
    if nuevas:
        db.add_all(nuevas)
        db.commit()
        print(f"✅ {len(nuevas)} característica(s) nuevas sembradas.")
    else:
        print("⚠️ El catálogo de características ya existe en la base de datos.")


class SeedSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    org_nombre: str = Field(min_length=1)
    org_slug: str = Field(min_length=1, max_length=100, pattern=r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
    admin_email: EmailStr
    admin_password: str = Field(min_length=12)

    @field_validator("admin_password")
    @classmethod
    def validar_largo_bcrypt(cls, v: str) -> str:
        if password_too_long(v):
            raise ValueError(f"ADMIN_PASSWORD no puede superar los {BCRYPT_MAX_BYTES} bytes")
        return v


def seed_data():
    try:
        cfg = SeedSettings()
    except ValidationError as exc:
        raise SystemExit(f"❌ Faltan o son inválidas variables de seed en .env:\n{exc}")

    db = SessionLocal()
    try:
        # 1. Organización (idempotente por slug)
        org = db.query(Organizacion).filter(Organizacion.slug == cfg.org_slug).first()
        if org is None:
            org = Organizacion(nombre=cfg.org_nombre, slug=cfg.org_slug)
            db.add(org)
            db.flush()
            print(f"✅ Organización '{cfg.org_nombre}' creada.")
        else:
            print(f"⚠️ La organización '{cfg.org_slug}' ya existe.")

        # 2. Usuario admin inicial (idempotente por email; nunca se imprime la clave)
        if db.query(Usuario).filter(Usuario.email == cfg.admin_email).first() is None:
            db.add(Usuario(
                organizacion_id=org.id,
                email=cfg.admin_email,
                password_hash=get_hash_password(cfg.admin_password),
                rol="admin",
            ))
            print(f"✅ Admin '{cfg.admin_email}' creado.")
        else:
            print(f"⚠️ El admin '{cfg.admin_email}' ya existe; no se modifica su clave.")

        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

    db = SessionLocal()
    try:
        seed_caracteristicas(db)
    finally:
        db.close()

if __name__ == "__main__":
    seed_data()