from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command, CommandStart
from aiogram.types import Message

from bot.db.models import User
from bot.keyboards.menus import main_menu

router = Router(name="start")


HELP_TEXT = (
    "<b>EventPing</b> — нагадування та події з Google Calendar.\n\n"
    "<b>Що вміє:</b>\n"
    "• підключає твій Google Calendar\n"
    "• нагадує про події заздалегідь\n"
    "• створює нові записи простим текстом\n\n"
    "<b>Швидке створення:</b>\n"
    "<code>Завтра 15:00 Зустріч з клієнтом</code>\n"
    "<code>21.07 18:30 Вечеря @Кафе</code>\n"
    "<code>Через 2 години Дзвінок</code>\n"
    "<code>В п'ятницю 10:00 Планерка</code>\n\n"
    "Або натисни <b>➕ Нова подія</b> і просто напиши текст."
)


@router.message(CommandStart())
async def cmd_start(message: Message, db_user: User) -> None:
    name = db_user.first_name or "там"
    status = (
        "Календар уже підключено ✓"
        if db_user.calendar_connected
        else "Спочатку підключи Google Calendar — кнопка нижче."
    )
    await message.answer(
        f"Привіт, {name}! Я <b>EventPing</b> 👋\n\n{status}\n\n"
        f"Нагадуватиму за <b>{db_user.reminder_minutes} хв</b> "
        f"(можна змінити в налаштуваннях).",
        reply_markup=main_menu(db_user),
    )


@router.message(Command("help"))
@router.message(F.text == "ℹ️ Допомога")
async def cmd_help(message: Message, db_user: User) -> None:
    await message.answer(HELP_TEXT, reply_markup=main_menu(db_user))


@router.message(Command("menu"))
async def cmd_menu(message: Message, db_user: User) -> None:
    await message.answer("Головне меню:", reply_markup=main_menu(db_user))
