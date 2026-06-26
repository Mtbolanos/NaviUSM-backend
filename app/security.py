import bcrypt
from cryptography.fernet import Fernet
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import Usuario

fernet = Fernet(settings.secret_key)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))


def get_hash_password(password: str) -> str:
    salt = bcrypt.gensalt()
    hashed = bcrypt.hashpw(password.encode("utf-8"), salt)
    return hashed.decode("utf-8")


def get_user_by_email(db: Session, email: str):
    return db.query(Usuario).filter(Usuario.email == email).first()


def set_auth_cookie(response: Response, user_id: str):
    encrypted = fernet.encrypt(user_id.encode())
    response.set_cookie(
        key="session",
        value=encrypted.decode("utf-8"),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="Lax",
        max_age=86400,
        path="/",
    )


def get_current_user(request: Request, db: Session = Depends(get_db)) -> Usuario:
    cookie = request.cookies.get("session")
    if not cookie:
        raise HTTPException(401, "Not authenticated")
    try:
        decrypted = fernet.decrypt(cookie, ttl=86400)
        user_id = decrypted.decode()
        user = db.query(Usuario).filter(Usuario.id == user_id).first()
        if not user or not user.is_active:
            raise HTTPException(401, "Invalid user")
        return user
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Invalid session")


def login_user(db: Session, email: str, password: str) -> Usuario:
    user = get_user_by_email(db, email)
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(400, "Invalid credentials")
    return user
