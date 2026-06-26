from sqlalchemy.orm import Session

# Placeholder — tablas ruta_evacuacion y ruta_evacuacion_arista existen en BD
# pero aún no tienen modelo SQLAlchemy (se acceden via raw SQL cuando se implemente).


def get_rutas_by_sede(db: Session, sede_id: str):
    raise NotImplementedError("Rutas de evacuación pendientes de implementar en Sprint 2")


def create_ruta_evacuacion(db: Session, sede_id: str, org_id, nombre: str, tipo_emergencia: str):
    raise NotImplementedError("Rutas de evacuación pendientes de implementar en Sprint 2")
