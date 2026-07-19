from __future__ import annotations

import logging
from html import escape

from aiogram import Bot
from apscheduler.schedulers.asyncio import AsyncIOScheduler

from bot.db.repository import Repository
from bot.google_cal.client import GoogleCalendarClient

logger = logging.getLogger(__name__)


class ReminderScheduler:
    def __init__(
        self,
        bot: Bot,
        repo: Repository,
        calendar: GoogleCalendarClient,
    ) -> None:
        self.bot = bot
        self.repo = repo
        self.calendar = calendar
        self.scheduler = AsyncIOScheduler(timezone="UTC")

    def start(self) -> None:
        self.scheduler.add_job(
            self.check_reminders,
            trigger="interval",
            minutes=1,
            id="reminders",
            replace_existing=True,
            max_instances=1,
            coalesce=True,
        )
        self.scheduler.start()
        logger.info("Reminder scheduler started")

    def shutdown(self) -> None:
        if self.scheduler.running:
            self.scheduler.shutdown(wait=False)

    async def check_reminders(self) -> None:
        users = await self.repo.list_connected_users()
        for user in users:
            try:
                due = await self.calendar.events_needing_reminder(user, window_minutes=1)
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Failed to fetch reminders for user %s", user.telegram_id
                )
                continue

            for event, remind_at in due:
                already = await self.repo.was_reminder_sent(
                    user.telegram_id, event.id, remind_at
                )
                if already:
                    continue

                loc = f"\n📍 {escape(event.location)}" if event.location else ""
                link = (
                    f'\n<a href="{escape(event.html_link)}">Відкрити</a>'
                    if event.html_link
                    else ""
                )
                text = (
                    f"⏰ <b>Нагадування</b> (за {user.reminder_minutes} хв)\n\n"
                    f"📌 <b>{escape(event.summary)}</b>\n"
                    f"🕒 {escape(event.format_when(user.timezone))}"
                    f"{loc}{link}"
                )
                try:
                    await self.bot.send_message(user.telegram_id, text)
                    await self.repo.mark_reminder_sent(
                        user.telegram_id, event.id, remind_at
                    )
                except Exception:  # noqa: BLE001
                    logger.exception(
                        "Failed to send reminder to %s", user.telegram_id
                    )
