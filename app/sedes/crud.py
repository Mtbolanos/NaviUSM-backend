from sqlalchemy.orm import Session

from app.models import Sede


def get_sedes_by_org(db: Session, org_id):
    return db.query(Sede).filter(Sede.organizacion_id == org_id).all()


def create_sede(db: Session, org_id, nombre: str, lat: float, lng: float, zoom: int = 18) -> Sede:
    sede = Sede(
        organizacion_id=org_id,
        nombre=nombre,
        latitud=lat,
        longitud=lng,
        zoom_defecto=zoom,
    )
    db.add(sede)
    db.commit()
    db.refresh(sede)
    return sede


def delete_sede(db: Session, sede_id: str, org_id) -> bool:
    sede = db.query(Sede).filter(Sede.id == sede_id, Sede.organizacion_id == org_id).first()
    if not sede:
        return False
    db.delete(sede)
    db.commit()
    return True
