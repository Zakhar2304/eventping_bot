from __future__ import annotations

from typing import Any, Awaitable, Callable, Dict

from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, User as TgUser

from bot.config import Settings
from bot.db.repository import Repository


class UserMiddleware(BaseMiddleware):
    def __init__(self, repo: Repository, settings: Settings) -> None:
        self.repo = repo
        self.settings = settings

    async def __call__(
        self,
        handler: Callable[[TelegramObject, Dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: Dict[str, Any],
    ) -> Any:
        tg_user: TgUser | None = data.get("event_from_user")
        if tg_user and not tg_user.is_bot:
            user = await self.repo.upsert_user(
                telegram_id=tg_user.id,
                username=tg_user.username,
                first_name=tg_user.first_name,
                timezone_name=self.settings.default_timezone,
                reminder_minutes=self.settings.default_reminder_minutes,
            )
            data["db_user"] = user
            data["repo"] = self.repo
        return await handler(event, data)
