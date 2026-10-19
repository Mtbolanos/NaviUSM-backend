"""Registro de ejecuciones del pipeline de publicacion (tabla ``publicacion``, migracion 0009).

Una fila por cada POST /publish y PATCH /edificios que llega a resolverse a una sede: exito
('publicado') o rechazo ('rechazado', con su status y motivo). Sirve para medir tiempos de
procesamiento y tasa de fallas sin depender de los snapshots, que la retencion borra.

Dos reglas, y por eso esto vive aparte del router y de crud:

1. Sesion propia. Cada fila se escribe con una ``SessionLocal()`` nueva y su propio commit, nunca
   con la sesion de la solicitud: en un rechazo esa sesion hace rollback, y la fila tiene que
   quedar igual. Ojo con el orden: ``publish_graph_data`` toma ``FOR UPDATE`` sobre la sede, y la
   FK de esta tabla pide ``KEY SHARE`` sobre la misma fila desde otra conexion; quien llama tiene
   que haber soltado esa transaccion antes de registrar. Por si no, ``lock_timeout`` corta la
   espera en vez de colgar la solicitud.
2. Nunca tumba ni cambia la respuesta. Cualquier error al registrar se loguea y se ignora, igual
   que ``validar_topologia``.
"""
import logging
from uuid import UUID

from fastapi import HTTPException, Request

from app import database
from app.models import Publicacion, Sede
from app.security import get_current_user

logger = logging.getLogger(__name__)

MAX_MOTIVO = 1000
LOCK_TIMEOUT = "2s"

# Plantilla de ruta -> origen. Son las que se registran tambien desde el handler de 422 (app/main.py).
ORIGENES = {
    "/admin/api/sedes/{sede_id}/publish": "publish",
    "/admin/api/sedes/{sede_id}/edificios": "patch_edificios",
}


def _nueva_sesion():
    """Sesion propia del registro, nunca la de la solicitud (ver el docstring del modulo)."""
    return database.SessionLocal()


def conteos(payload) -> dict | None:
    """Largo de cada coleccion lista del payload; None si no es un objeto."""
    if not isinstance(payload, dict):
        return None
    return {k: len(v) for k, v in payload.items() if isinstance(v, list)}


def bytes_recibidos(request: Request) -> int | None:
    try:
        return int(request.headers["content-length"])
    except (KeyError, ValueError):
        return None


def _motivo(detail) -> str | None:
    if detail is None:
        return None
    return str(detail)[:MAX_MOTIVO]


def registrar(
    *, sede_id, organizacion_id, usuario_id, origen: str, resultado: str, status_http: int,
    version: int | None = None, motivo=None, tiempos_ms: dict | None = None,
    validacion: dict | None = None, bytes: int | None = None, conteos: dict | None = None,
) -> None:
    """Inserta una fila en su propia transaccion. No lanza nunca."""
    try:
        with _nueva_sesion() as s:
            s.connection().exec_driver_sql(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
            s.add(Publicacion(
                sede_id=sede_id, organizacion_id=organizacion_id, usuario_id=usuario_id,
                origen=origen, resultado=resultado, status_http=status_http, version=version,
                motivo=_motivo(motivo), tiempos_ms=tiempos_ms, validacion=validacion,
                bytes=bytes, conteos=conteos,
            ))
            s.commit()
    except Exception:
        logger.exception("no se pudo registrar la publicacion sede=%s resultado=%s", sede_id, resultado)


def registrar_rechazo_validacion(request: Request, status_http: int, motivo, body) -> None:
    """Rechazo que se resuelve en el handler de RequestValidationError (Nivel 2, area de la sede,
    cuerpo invalido del PATCH). Ahi no hay usuario ni sede resueltos: se recalculan con la cookie,
    en una sesion propia. Sin sesion valida, o si la sede no existe o es de otra organizacion, no
    se registra nada. No lanza nunca."""
    try:
        ruta = request.scope.get("route")
        origen = ORIGENES.get(getattr(ruta, "path", None))
        if origen is None:
            return
        try:
            sede_id = UUID(str(request.path_params.get("sede_id")))
        except ValueError:
            return
        with _nueva_sesion() as s:
            try:
                user = get_current_user(request, s)
            except HTTPException:
                return
            sede = s.query(Sede.id).filter(Sede.id == sede_id, Sede.organizacion_id == user.organizacion_id).first()
            if not sede:
                return
            org_id, usuario_id = user.organizacion_id, user.id
        registrar(
            sede_id=sede_id, organizacion_id=org_id, usuario_id=usuario_id, origen=origen,
            resultado="rechazado", status_http=status_http, motivo=motivo,
            bytes=bytes_recibidos(request), conteos=conteos(body),
        )
    except Exception:
        logger.exception("no se pudo registrar el rechazo de validacion")
