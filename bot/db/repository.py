from __future__ import annotations

import sqlite3
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from bot.config import Settings
from bot.db.models import User


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_dt(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value
    text = str(value).replace("Z", "+00:00")
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class Repository(ABC):
    @abstractmethod
    async def init(self) -> None: ...

    @abstractmethod
    async def upsert_user(
        self,
        telegram_id: int,
        username: Optional[str],
        first_name: Optional[str],
        timezone_name: str,
        reminder_minutes: int,
    ) -> User: ...

    @abstractmethod
    async def get_user(self, telegram_id: int) -> Optional[User]: ...

    @abstractmethod
    async def update_user(self, telegram_id: int, **fields: Any) -> User: ...

    @abstractmethod
    async def list_connected_users(self) -> list[User]: ...

    @abstractmethod
    async def was_reminder_sent(
        self, telegram_id: int, event_id: str, remind_at: datetime
    ) -> bool: ...

    @abstractmethod
    async def mark_reminder_sent(
        self, telegram_id: int, event_id: str, remind_at: datetime
    ) -> None: ...


class SqliteRepository(Repository):
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    async def init(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(
                """
                create table if not exists users (
                    telegram_id integer primary key,
                    username text,
                    first_name text,
                    timezone text not null,
                    reminder_minutes integer not null,
                    google_refresh_token text,
                    google_token_expiry text,
                    google_access_token text,
                    calendar_id text not null default 'primary',
                    is_active integer not null default 1,
                    created_at text not null,
                    updated_at text not null
                );

                create table if not exists sent_reminders (
                    id integer primary key autoincrement,
                    telegram_id integer not null,
                    event_id text not null,
                    remind_at text not null,
                    created_at text not null,
                    unique (telegram_id, event_id, remind_at),
                    foreign key (telegram_id) references users(telegram_id)
                        on delete cascade
                );
                """
            )
            conn.commit()

    def _row_to_user(self, row: sqlite3.Row) -> User:
        return User(
            telegram_id=row["telegram_id"],
            username=row["username"],
            first_name=row["first_name"],
            timezone=row["timezone"],
            reminder_minutes=row["reminder_minutes"],
            google_refresh_token=row["google_refresh_token"],
            google_token_expiry=_parse_dt(row["google_token_expiry"]),
            google_access_token=row["google_access_token"],
            calendar_id=row["calendar_id"] or "primary",
            is_active=bool(row["is_active"]),
            created_at=_parse_dt(row["created_at"]),
            updated_at=_parse_dt(row["updated_at"]),
        )

    async def upsert_user(
        self,
        telegram_id: int,
        username: Optional[str],
        first_name: Optional[str],
        timezone_name: str,
        reminder_minutes: int,
    ) -> User:
        now = _utc_now().isoformat()
        with self._connect() as conn:
            existing = conn.execute(
                "select * from users where telegram_id = ?", (telegram_id,)
            ).fetchone()
            if existing:
                conn.execute(
                    """
                    update users
                    set username = ?, first_name = ?, is_active = 1, updated_at = ?
                    where telegram_id = ?
                    """,
                    (username, first_name, now, telegram_id),
                )
            else:
                conn.execute(
                    """
                    insert into users (
                        telegram_id, username, first_name, timezone,
                        reminder_minutes, calendar_id, is_active, created_at, updated_at
                    ) values (?, ?, ?, ?, ?, 'primary', 1, ?, ?)
                    """,
                    (
                        telegram_id,
                        username,
                        first_name,
                        timezone_name,
                        reminder_minutes,
                        now,
                        now,
                    ),
                )
            conn.commit()
        user = await self.get_user(telegram_id)
        assert user is not None
        return user

    async def get_user(self, telegram_id: int) -> Optional[User]:
        with self._connect() as conn:
            row = conn.execute(
                "select * from users where telegram_id = ?", (telegram_id,)
            ).fetchone()
        return self._row_to_user(row) if row else None

    async def update_user(self, telegram_id: int, **fields: Any) -> User:
        if not fields:
            user = await self.get_user(telegram_id)
            if not user:
                raise ValueError(f"User {telegram_id} not found")
            return user

        allowed = {
            "username",
            "first_name",
            "timezone",
            "reminder_minutes",
            "google_refresh_token",
            "google_token_expiry",
            "google_access_token",
            "calendar_id",
            "is_active",
        }
        updates = {k: v for k, v in fields.items() if k in allowed}
        updates["updated_at"] = _utc_now().isoformat()

        if "google_token_expiry" in updates and isinstance(
            updates["google_token_expiry"], datetime
        ):
            updates["google_token_expiry"] = updates["google_token_expiry"].isoformat()
        if "is_active" in updates:
            updates["is_active"] = 1 if updates["is_active"] else 0

        columns = ", ".join(f"{key} = ?" for key in updates)
        values = list(updates.values()) + [telegram_id]
        with self._connect() as conn:
            conn.execute(
                f"update users set {columns} where telegram_id = ?",
                values,
            )
            conn.commit()
        user = await self.get_user(telegram_id)
        if not user:
            raise ValueError(f"User {telegram_id} not found")
        return user

    async def list_connected_users(self) -> list[User]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                select * from users
                where is_active = 1 and google_refresh_token is not null
                  and google_refresh_token != ''
                """
            ).fetchall()
        return [self._row_to_user(row) for row in rows]

    async def was_reminder_sent(
        self, telegram_id: int, event_id: str, remind_at: datetime
    ) -> bool:
        with self._connect() as conn:
            row = conn.execute(
                """
                select 1 from sent_reminders
                where telegram_id = ? and event_id = ? and remind_at = ?
                """,
                (telegram_id, event_id, remind_at.isoformat()),
            ).fetchone()
        return row is not None

    async def mark_reminder_sent(
        self, telegram_id: int, event_id: str, remind_at: datetime
    ) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                insert or ignore into sent_reminders
                    (telegram_id, event_id, remind_at, created_at)
                values (?, ?, ?, ?)
                """,
                (
                    telegram_id,
                    event_id,
                    remind_at.isoformat(),
                    _utc_now().isoformat(),
                ),
            )
            conn.commit()


class SupabaseRepository(Repository):
    def __init__(self, url: str, key: str) -> None:
        from supabase import create_client

        self.client = create_client(url, key)

    async def init(self) -> None:
        # Schema is applied manually via supabase/schema.sql
        return None

    def _row_to_user(self, row: dict[str, Any]) -> User:
        return User(
            telegram_id=int(row["telegram_id"]),
            username=row.get("username"),
            first_name=row.get("first_name"),
            timezone=row.get("timezone") or "Europe/Kyiv",
            reminder_minutes=int(row.get("reminder_minutes") or 30),
            google_refresh_token=row.get("google_refresh_token"),
            google_token_expiry=_parse_dt(row.get("google_token_expiry")),
            google_access_token=row.get("google_access_token"),
            calendar_id=row.get("calendar_id") or "primary",
            is_active=bool(row.get("is_active", True)),
            created_at=_parse_dt(row.get("created_at")),
            updated_at=_parse_dt(row.get("updated_at")),
        )

    async def upsert_user(
        self,
        telegram_id: int,
        username: Optional[str],
        first_name: Optional[str],
        timezone_name: str,
        reminder_minutes: int,
    ) -> User:
        existing = await self.get_user(telegram_id)
        now = _utc_now().isoformat()
        if existing:
            result = (
                self.client.table("users")
                .update(
                    {
                        "username": username,
                        "first_name": first_name,
                        "is_active": True,
                        "updated_at": now,
                    }
                )
                .eq("telegram_id", telegram_id)
                .execute()
            )
        else:
            result = (
                self.client.table("users")
                .insert(
                    {
                        "telegram_id": telegram_id,
                        "username": username,
                        "first_name": first_name,
                        "timezone": timezone_name,
                        "reminder_minutes": reminder_minutes,
                        "calendar_id": "primary",
                        "is_active": True,
                        "created_at": now,
                        "updated_at": now,
                    }
                )
                .execute()
            )
        return self._row_to_user(result.data[0])

    async def get_user(self, telegram_id: int) -> Optional[User]:
        result = (
            self.client.table("users")
            .select("*")
            .eq("telegram_id", telegram_id)
            .limit(1)
            .execute()
        )
        if not result.data:
            return None
        return self._row_to_user(result.data[0])

    async def update_user(self, telegram_id: int, **fields: Any) -> User:
        allowed = {
            "username",
            "first_name",
            "timezone",
            "reminder_minutes",
            "google_refresh_token",
            "google_token_expiry",
            "google_access_token",
            "calendar_id",
            "is_active",
        }
        updates = {k: v for k, v in fields.items() if k in allowed}
        updates["updated_at"] = _utc_now().isoformat()
        if "google_token_expiry" in updates and isinstance(
            updates["google_token_expiry"], datetime
        ):
            updates["google_token_expiry"] = updates["google_token_expiry"].isoformat()

        result = (
            self.client.table("users")
            .update(updates)
            .eq("telegram_id", telegram_id)
            .execute()
        )
        if not result.data:
            raise ValueError(f"User {telegram_id} not found")
        return self._row_to_user(result.data[0])

    async def list_connected_users(self) -> list[User]:
        result = (
            self.client.table("users")
            .select("*")
            .eq("is_active", True)
            .not_.is_("google_refresh_token", "null")
            .execute()
        )
        users = [self._row_to_user(row) for row in result.data or []]
        return [u for u in users if u.google_refresh_token]

    async def was_reminder_sent(
        self, telegram_id: int, event_id: str, remind_at: datetime
    ) -> bool:
        result = (
            self.client.table("sent_reminders")
            .select("id")
            .eq("telegram_id", telegram_id)
            .eq("event_id", event_id)
            .eq("remind_at", remind_at.isoformat())
            .limit(1)
            .execute()
        )
        return bool(result.data)

    async def mark_reminder_sent(
        self, telegram_id: int, event_id: str, remind_at: datetime
    ) -> None:
        self.client.table("sent_reminders").upsert(
            {
                "telegram_id": telegram_id,
                "event_id": event_id,
                "remind_at": remind_at.isoformat(),
                "created_at": _utc_now().isoformat(),
            },
            on_conflict="telegram_id,event_id,remind_at",
        ).execute()


def create_repository(settings: Settings) -> Repository:
    if settings.db_backend == "supabase":
        if not settings.supabase_ready:
            raise RuntimeError(
                "DB_BACKEND=supabase, але SUPABASE_URL / SUPABASE_KEY порожні"
            )
        return SupabaseRepository(settings.supabase_url, settings.supabase_key)
    return SqliteRepository(settings.database_file)
