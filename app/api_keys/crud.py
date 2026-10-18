import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from app.models import ApiKey

KEY_PREFIX = "nvu_"
PREFIJO_VISIBLE = 12               # "nvu_" + 8 caracteres: identifica la key en el panel sin revelarla
LAST_USED_THROTTLE = timedelta(minutes=5)


def hash_key(raw_key: str) -> str:
    # Key aleatoria de 256 bits: SHA-256 basta (bcrypt/argon2 son para contraseñas de baja entropía)
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def create_api_key(db: Session, org_id, user_id, nombre: str, expires_at: datetime | None) -> tuple[ApiKey, str]:
    raw_key = KEY_PREFIX + secrets.token_urlsafe(32)
    api_key = ApiKey(
        organizacion_id=org_id,
        nombre=nombre,
        prefijo=raw_key[:PREFIJO_VISIBLE],
        key_hash=hash_key(raw_key),
        created_by=user_id,
        expires_at=expires_at,
    )
    db.add(api_key)
    db.commit()
    db.refresh(api_key)
    return api_key, raw_key  # la key en claro solo se devuelve aquí, una vez


def list_api_keys(db: Session, org_id):
    return db.query(ApiKey).filter(ApiKey.organizacion_id == org_id).order_by(ApiKey.created_at.desc()).all()


def revoke_api_key(db: Session, key_id, org_id) -> bool:
    api_key = db.query(ApiKey).filter(ApiKey.id == key_id, ApiKey.organizacion_id == org_id).first()
    if not api_key:
        return False
    if api_key.revoked_at is None:
        api_key.revoked_at = datetime.now(timezone.utc)
        db.commit()
    return True


def is_active(api_key: ApiKey) -> bool:
    now = datetime.now(timezone.utc)
    return api_key.revoked_at is None and (api_key.expires_at is None or api_key.expires_at > now)


def get_active_key_by_raw(db: Session, raw_key: str) -> ApiKey | None:
    if not raw_key or not raw_key.startswith(KEY_PREFIX):
        return None
    api_key = db.query(ApiKey).filter(ApiKey.key_hash == hash_key(raw_key)).first()
    if not api_key or not is_active(api_key):
        return None
    touch_last_used(db, api_key)
    return api_key


def get_active_key_by_id(db: Session, key_id) -> ApiKey | None:
    api_key = db.query(ApiKey).filter(ApiKey.id == key_id).first()
    if not api_key or not is_active(api_key):
        return None
    touch_last_used(db, api_key)
    return api_key


def touch_last_used(db: Session, api_key: ApiKey) -> None:
    # Como máximo una escritura cada 5 minutos por key, para no escribir en la BD en cada request
    now = datetime.now(timezone.utc)
    if api_key.last_used_at is None or now - api_key.last_used_at > LAST_USED_THROTTLE:
        api_key.last_used_at = now
        db.commit()