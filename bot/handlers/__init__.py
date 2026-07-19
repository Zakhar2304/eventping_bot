from aiogram import Router

from bot.handlers import calendar, events, start, settings


def setup_routers() -> Router:
    root = Router()
    root.include_router(start.router)
    root.include_router(calendar.router)
    root.include_router(events.router)
    root.include_router(settings.router)
    return root
