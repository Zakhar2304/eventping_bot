from __future__ import annotations

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import CallbackQuery, Message

from bot.db.models import User
from bot.db.repository import Repository
from bot.google_cal.auth import GoogleOAuthService
from bot.keyboards.menus import main_menu, reminder_presets_kb, settings_kb, timezone_kb

router = Router(name="settings")


def _settings_text(user: User) -> str:
    cal = "підключено ✓" if user.calendar_connected else "не підключено"
    return (
        "<b>Налаштування</b>\n\n"
        f"🔗 Календар: {cal}\n"
        f"⏰ Нагадування: за {user.reminder_minutes} хв\n"
        f"🌍 Часовий пояс: {user.timezone}"
    )


@router.message(Command("settings"))
@router.message(F.text == "⚙️ Налаштування")
@router.message(F.text == "⏰ Нагадування")
async def open_settings(message: Message, db_user: User) -> None:
    await message.answer(
        _settings_text(db_user),
        reply_markup=settings_kb(db_user),
    )


@router.callback_query(F.data == "settings:open")
async def settings_open_cb(callback: CallbackQuery, db_user: User, repo: Repository) -> None:
    user = await repo.get_user(db_user.telegram_id) or db_user
    if callback.message:
        await callback.message.edit_text(
            _settings_text(user),
            reply_markup=settings_kb(user),
        )
    await callback.answer()


@router.callback_query(F.data == "settings:close")
async def settings_close(callback: CallbackQuery, db_user: User) -> None:
    if callback.message:
        await callback.message.edit_text("Налаштування закрито.")
        await callback.message.answer("Меню:", reply_markup=main_menu(db_user))
    await callback.answer()


@router.callback_query(F.data == "settings:reminder")
async def settings_reminder(callback: CallbackQuery, db_user: User) -> None:
    if callback.message:
        await callback.message.edit_text(
            "За скільки нагадувати про подію?",
            reply_markup=reminder_presets_kb(db_user.reminder_minutes),
        )
    await callback.answer()


@router.callback_query(F.data.startswith("reminder:set:"))
async def set_reminder(
    callback: CallbackQuery, db_user: User, repo: Repository
) -> None:
    assert callback.data is not None
    minutes = int(callback.data.split(":")[-1])
    user = await repo.update_user(db_user.telegram_id, reminder_minutes=minutes)
    if callback.message:
        await callback.message.edit_text(
            _settings_text(user),
            reply_markup=settings_kb(user),
        )
    await callback.answer(f"Нагадування: за {minutes} хв")


@router.callback_query(F.data == "settings:timezone")
async def settings_timezone(callback: CallbackQuery, db_user: User) -> None:
    if callback.message:
        await callback.message.edit_text(
            "Обери часовий пояс:",
            reply_markup=timezone_kb(db_user.timezone),
        )
    await callback.answer()


@router.callback_query(F.data.startswith("tz:set:"))
async def set_timezone(
    callback: CallbackQuery, db_user: User, repo: Repository
) -> None:
    assert callback.data is not None
    zone = callback.data.split(":", 2)[-1]
    user = await repo.update_user(db_user.telegram_id, timezone=zone)
    if callback.message:
        await callback.message.edit_text(
            _settings_text(user),
            reply_markup=settings_kb(user),
        )
    await callback.answer(f"Пояс: {zone}")


@router.callback_query(F.data == "settings:disconnect")
async def disconnect_calendar(
    callback: CallbackQuery,
    db_user: User,
    oauth: GoogleOAuthService,
    repo: Repository,
) -> None:
    await oauth.disconnect(db_user.telegram_id)
    user = await repo.get_user(db_user.telegram_id) or db_user
    if callback.message:
        await callback.message.edit_text(
            _settings_text(user),
            reply_markup=settings_kb(user),
        )
        await callback.message.answer(
            "Календар відключено.",
            reply_markup=main_menu(user),
        )
    await callback.answer()


@router.callback_query(F.data == "settings:connect")
async def connect_from_settings(callback: CallbackQuery, db_user: User) -> None:
    if callback.message:
        await callback.message.answer(
            "Натисни кнопку меню «🔗 Підключити календар».",
            reply_markup=main_menu(db_user),
        )
    await callback.answer()
