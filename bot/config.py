from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal, Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parent.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    bot_token: str = Field(alias="BOT_TOKEN")

    google_client_id: str = Field(default="", alias="GOOGLE_CLIENT_ID")
    google_client_secret: str = Field(default="", alias="GOOGLE_CLIENT_SECRET")
    google_redirect_uri: str = Field(
        default="http://localhost:8080/oauth/callback",
        alias="GOOGLE_REDIRECT_URI",
    )
    public_base_url: str = Field(default="", alias="PUBLIC_BASE_URL")
    oauth_host: str = Field(default="0.0.0.0", alias="OAUTH_HOST")
    oauth_port: int = Field(default=8080, alias="OAUTH_PORT")
    # Cloud platforms (Railway/Render/Fly) inject PORT
    port: Optional[int] = Field(default=None, alias="PORT")

    default_timezone: str = Field(default="Europe/Kyiv", alias="DEFAULT_TIMEZONE")
    default_reminder_minutes: int = Field(default=30, alias="DEFAULT_REMINDER_MINUTES")

    db_backend: Literal["sqlite", "supabase"] = Field(default="sqlite", alias="DB_BACKEND")
    database_path: str = Field(default="data/eventping.db", alias="DATABASE_PATH")
    supabase_url: str = Field(default="", alias="SUPABASE_URL")
    supabase_key: str = Field(default="", alias="SUPABASE_KEY")

    @field_validator("public_base_url", mode="before")
    @classmethod
    def _strip_slash(cls, value: object) -> object:
        if isinstance(value, str):
            return value.rstrip("/")
        return value

    @property
    def database_file(self) -> Path:
        path = Path(self.database_path)
        if not path.is_absolute():
            path = ROOT_DIR / path
        return path

    @property
    def listen_port(self) -> int:
        if self.port is not None:
            return int(self.port)
        return int(self.oauth_port)

    @property
    def resolved_public_base_url(self) -> str:
        if self.public_base_url:
            return self.public_base_url.rstrip("/")

        render = os.getenv("RENDER_EXTERNAL_URL", "").rstrip("/")
        if render:
            return render

        railway = os.getenv("RAILWAY_PUBLIC_DOMAIN", "").strip()
        if railway:
            if railway.startswith("http"):
                return railway.rstrip("/")
            return f"https://{railway}"

        fly = os.getenv("FLY_APP_NAME", "").strip()
        if fly:
            return f"https://{fly}.fly.dev"

        return ""

    @property
    def redirect_uri(self) -> str:
        """Public OAuth callback URL used with Google."""
        base = self.resolved_public_base_url
        if base:
            return f"{base}/oauth/callback"
        return self.google_redirect_uri

    @property
    def google_ready(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def supabase_ready(self) -> bool:
        return bool(self.supabase_url and self.supabase_key)


@lru_cache
def get_settings() -> Settings:
    return Settings()
