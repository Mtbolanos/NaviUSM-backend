from sqlalchemy.orm import Session

from app.models import Usuario
from app.security import get_hash_password


def change_user_password(db: Session, user: Usuario, new_password: str) -> Usuario:
    user.password_hash = get_hash_password(new_password)
    db.commit()
    db.refresh(user)
    return user
