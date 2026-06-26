from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session, joinedload
from cryptography.fernet import Fernet
from config import SECRET_KEY
from database import get_db
from models import Usuario
from crud import get_user_by_email, verify_password
from schemas import Login

fernet = Fernet(SECRET_KEY)

def set_auth_cookie(response: Response, user_id: str):
    encrypted = fernet.encrypt(user_id.encode())
    response.set_cookie(
        key="session",
        value=encrypted.decode('utf-8'),
        httponly=True,
        secure=False,
        samesite='Lax',
        max_age=86400,
        path="/"
    )

def get_current_user(request: Request, db: Session = Depends(get_db)):
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

    except Exception as e:
        print(f"[DEBUG] Error desencriptando cookie: {e}")
        raise HTTPException(401, "Invalid session")
    
def login_user(db: Session, login: Login):
    user = get_user_by_email(db, login.email) 
    if not user or not verify_password(login.password, user.password_hash): 
        raise HTTPException(400, "Invalid credentials")
    return user