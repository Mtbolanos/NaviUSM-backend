from sqlalchemy.orm import Session

from app.models import Usuario
from app.security import get_hash_password


def get_usuarios_by_org(db: Session, org_id):
    return db.query(Usuario).filter(Usuario.organizacion_id == org_id).all()


def create_usuario(db: Session, org_id, email: str, password: str, rol: str = "editor") -> Usuario:
    usuario = Usuario(
        organizacion_id=org_id,
        email=email,
        password_hash=get_hash_password(password),
        rol=rol,
    )
    db.add(usuario)
    db.commit()
    db.refresh(usuario)
    return usuario


def deactivate_usuario(db: Session, user_id: str, org_id) -> bool:
    user = db.query(Usuario).filter(Usuario.id == user_id, Usuario.organizacion_id == org_id).first()
    if not user:
        return False
    user.is_active = False
    db.commit()
    return True
