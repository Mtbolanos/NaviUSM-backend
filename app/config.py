import os
from dotenv import load_dotenv

load_dotenv()


class Settings:
    database_url: str = os.getenv("DATABASE_URL", "")
    secret_key: str = os.getenv("SECRET_KEY", "")
    cookie_secure: bool = os.getenv("COOKIE_SECURE", "false").lower() == "true"
    root_path: str = os.getenv("ROOT_PATH", "")


settings = Settings()
