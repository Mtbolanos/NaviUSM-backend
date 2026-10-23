import bcrypt
from cryptography.fernet import Fernet
from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import Usuario

fernet = Fernet(settings.secret_key)

# bcrypt solo usa los primeros 72 bytes de la contraseña. Desde bcrypt 5 hashpw y checkpw lanzan
# ValueError con contraseñas más largas en vez de truncarlas en silencio.
BCRYPT_MAX_BYTES = 72


def password_too_long(password: str) -> bool:
    return len(password.encode("utf-8")) > BCRYPT_MAX_BYTES


def verify_password(plain_password: str, hashed_password: str) -> bool:
    # Se trunca igual que hacía bcrypt antes de la versión 5: compatible con los hashes ya guardados,
    # y una contraseña larga en el login responde "credenciales inválidas" en vez de un error 500
    candidate = plain_password.encode("utf-8")[:BCRYPT_MAX_BYTES]
    return bcrypt.checkpw(candidate, hashed_password.encode("utf-8"))


def get_hash_password(password: str) -> str:
    if password_too_long(password):
        raise ValueError(f"La contraseña no puede superar los {BCRYPT_MAX_BYTES} bytes")
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
        max_age=settings.session_max_age,
        path="/",
    )


def get_current_user(request: Request, db: Session = Depends(get_db)) -> Usuario:
    cookie = request.cookies.get("session")
    if not cookie:
        raise HTTPException(401, "Not authenticated")
    try:
        decrypted = fernet.decrypt(cookie, ttl=settings.session_max_age)
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
