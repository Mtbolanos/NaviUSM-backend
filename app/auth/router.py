from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session

from app.auth.crud import change_user_password
from app.database import get_db
from app.models import Usuario
from app.security import get_current_user, login_user, set_auth_cookie, verify_password

router = APIRouter()
templates = Jinja2Templates(directory="templates")
templates.env.cache = None


def _root_path(request: Request) -> str:
    return request.scope.get("root_path", "")


@router.get("/")
async def root(request: Request, db: Session = Depends(get_db)):
    try:
        get_current_user(request, db)
        return RedirectResponse(f"{_root_path(request)}/admin")
    except HTTPException as e:
        if e.status_code == 401:
            return RedirectResponse(f"{_root_path(request)}/login")
        raise


@router.get("/login")
def get_login(request: Request):
    return templates.TemplateResponse(request, "login.html")


@router.post("/login")
def post_login(
    request: Request,
    email: str = Form(...),
    password: str = Form(...),
    db: Session = Depends(get_db),
):
    try:
        user = login_user(db, email, password)
        redirect = RedirectResponse(f"{_root_path(request)}/admin", status_code=303)
        set_auth_cookie(redirect, str(user.id))
        return redirect
    except HTTPException as e:
        if e.status_code == 400:
            return templates.TemplateResponse(
                request, "login.html", {"error": "Credenciales inválidas"}
            )
        raise


@router.get("/logout")
def logout(request: Request):
    redirect = RedirectResponse(f"{_root_path(request)}/login", status_code=303)
    redirect.delete_cookie("session")
    return redirect


@router.get("/cambiar-contrasena")
def get_change_password(
    request: Request,
    user: Usuario = Depends(get_current_user),
):
    return templates.TemplateResponse(request, "cambiar_contrasena.html", {"user": user})


@router.post("/cambiar-contrasena")
def post_change_password(
    request: Request,
    old_password: str = Form(...),
    new_password: str = Form(...),
    db: Session = Depends(get_db),
    user: Usuario = Depends(get_current_user),
):
    if not verify_password(old_password, user.password_hash):
        return templates.TemplateResponse(
            request,
            "cambiar_contrasena.html",
            {"user": user, "error": "La contraseña actual es incorrecta."},
        )
    change_user_password(db, user, new_password)
    return templates.TemplateResponse(
        request,
        "cambiar_contrasena.html",
        {"user": user, "success": "Contraseña actualizada exitosamente."},
    )
