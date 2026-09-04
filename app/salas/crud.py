from sqlalchemy.orm import Session

from app.models import Sala


def get_salas_by_edificio(db: Session, edificio_id):
    return db.query(Sala).filter(Sala.edificio_id == edificio_id).order_by(Sala.piso, Sala.nombre).all()


def create_sala(db: Session, edificio_id, org_id, piso: int, nombre: str) -> Sala:
    sala = Sala(edificio_id=edificio_id, organizacion_id=org_id, piso=piso, nombre=nombre)
    db.add(sala)
    db.commit()
    db.refresh(sala)
    return sala


def rename_sala(db: Session, sala_id, nombre: str) -> Sala | None:
    sala = db.query(Sala).filter(Sala.id == sala_id).first()
    if not sala:
        return None
    sala.nombre = nombre
    db.commit()
    db.refresh(sala)
    return sala


def delete_sala(db: Session, sala_id) -> bool:
    sala = db.query(Sala).filter(Sala.id == sala_id).first()
    if not sala:
        return False
    db.delete(sala)
    db.commit()
    return True
