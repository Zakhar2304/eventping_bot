from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Optional


@dataclass
class User:
    telegram_id: int
    username: Optional[str] = None
    first_name: Optional[str] = None
    timezone: str = "Europe/Kyiv"
    reminder_minutes: int = 30
    google_refresh_token: Optional[str] = None
    google_token_expiry: Optional[datetime] = None
    google_access_token: Optional[str] = None
    calendar_id: str = "primary"
    is_active: bool = True
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @property
    def calendar_connected(self) -> bool:
        return bool(self.google_refresh_token)
