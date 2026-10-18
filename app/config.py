from typing import Literal
from cryptography.fernet import Fernet
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str
    secret_key: str
    cookie_secure: bool = False
    session_max_age: int = 86400

    # API móvil
    mobile_session_ttl: int = 3600               # duración del token de sesión de la app (segundos)
    mobile_attestation: Literal["off"] = "off"   # futuro: "firebase" / "native" (App Attest + Play Integrity)
    api_docs: bool = False                       # expone /docs y /redoc con la documentación de la API móvil

    # Buscador de lugares (Photon, datos de OpenStreetMap). GEOCODER_URL permite apuntar a una instancia propia
    geocoder_url: str = "https://photon.komoot.io/api/"
    geocoder_country: str = "CL"
    geocoder_user_agent: str = "NaviUSM/1.0"
    
    @field_validator("secret_key")
    @classmethod
    def validar_fernet_key(cls, v: str) -> str:
        try:
            Fernet(v)
        except Exception as exc:
            raise ValueError(
                "SECRET_KEY no es una clave Fernet válida. Generar con: "
                "python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
            ) from exc
        return v


settings = Settings()