from __future__ import annotations

import asyncio
import logging
import sys

from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.enums import ParseMode
from aiogram.fsm.storage.memory import MemoryStorage

from bot.config import get_settings
from bot.db.repository import create_repository
from bot.google_cal.auth import GoogleOAuthService
from bot.google_cal.client import GoogleCalendarClient
from bot.handlers import setup_routers
from bot.middlewares.user import UserMiddleware
from bot.services.scheduler import ReminderScheduler

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("eventping")


async def main() -> None:
    settings = get_settings()
    if not settings.bot_token or "незправжн" in settings.bot_token:
        # Allow placeholder token; real validation happens on API calls
        pass

    repo = create_repository(settings)
    await repo.init()

    bot = Bot(
        token=settings.bot_token,
        default=DefaultBotProperties(parse_mode=ParseMode.HTML),
    )
    dp = Dispatcher(storage=MemoryStorage())

    oauth = GoogleOAuthService(settings, repo)
    calendar = GoogleCalendarClient(oauth)

    dp["settings"] = settings
    dp["repo"] = repo
    dp["oauth"] = oauth
    dp["calendar"] = calendar

    dp.message.middleware(UserMiddleware(repo, settings))
    dp.callback_query.middleware(UserMiddleware(repo, settings))
    dp.include_router(setup_routers())

    scheduler = ReminderScheduler(bot, repo, calendar)

    if settings.google_ready:
        await oauth.start_callback_server()
        logger.info(
            "HTTP listening on %s:%s | OAuth callback: %s",
            settings.oauth_host,
            settings.listen_port,
            settings.redirect_uri,
        )
    else:
        logger.warning(
            "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET порожні — "
            "підключення календаря буде недоступне, доки не заповниш .env"
        )

    scheduler.start()
    logger.info(
        "EventPing started (db=%s, public=%s)",
        settings.db_backend,
        settings.resolved_public_base_url or "local",
    )

    try:
        await dp.start_polling(
            bot,
            settings=settings,
            repo=repo,
            oauth=oauth,
            calendar=calendar,
        )
    finally:
        scheduler.shutdown()
        await oauth.stop_callback_server()
        await bot.session.close()


def run() -> None:
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        logger.info("Stopped")


if __name__ == "__main__":
    run()
