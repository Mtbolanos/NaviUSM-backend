# Creación inicial de datos en BD
from app.database import SessionLocal
from app.models import Caracteristica, Organizacion, Sede, Usuario
from app.security import get_hash_password
from sqlalchemy.exc import IntegrityError

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


def seed_data():
    db = SessionLocal()
    try:
        # 1. Crear Tenant (Universidad)
        org = Organizacion(nombre="Universidad Técnica Federico Santa María", slug="usm")
        db.add(org)
        db.commit()
        db.refresh(org)

        # 2. Crear Sede
        sede = Sede(
            organizacion_id=org.id, 
            nombre="Sede Viña del Mar",
            latitud=-33.036577,     # Centro real del mapa de la USM Viña
            longitud=-71.486578,
            zoom_defecto=18
        )
        db.add(sede)
        
        # 3. Crear Usuario Admin
        admin = Usuario(
            organizacion_id=org.id,
            email="admin@usm.cl",
            password_hash=get_hash_password("admin123"),
            rol="admin"
        )
        db.add(admin)
        db.commit()
        
        print(f"✅ Setup completado.\nSede ID: {sede.id}\nLogin: admin@usm.cl / admin123")
        
    except IntegrityError:
        db.rollback()
        print("⚠️ Los datos iniciales ya existen en la base de datos.")
    finally:
        db.close()

    db = SessionLocal()
    try:
        seed_caracteristicas(db)
    finally:
        db.close()

if __name__ == "__main__":
    seed_data()