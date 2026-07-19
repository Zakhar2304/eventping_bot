from __future__ import annotations

import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from bot.config import Settings
from bot.db.models import User
from bot.google_cal.auth import GoogleOAuthService
from bot.google_cal.client import GoogleCalendarClient
from bot.keyboards.menus import connect_calendar_kb, main_menu
from bot.states.forms import OAuthStates

router = Router(name="calendar")
logger = logging.getLogger(__name__)


@router.message(Command("connect"))
@router.message(F.text.in_({"🔗 Підключити календар", "🔗 Календар ✓"}))
async def connect_calendar(
    message: Message,
    state: FSMContext,
    db_user: User,
    settings: Settings,
    oauth: GoogleOAuthService,
) -> None:
    if db_user.calendar_connected and message.text == "🔗 Календар ✓":
        await message.answer(
            "Google Calendar уже підключено.\n"
            "Щоб відключити — зайди в ⚙️ Налаштування.",
            reply_markup=main_menu(db_user),
        )
        return

    if not settings.google_ready:
        await message.answer(
            "Google OAuth ще не налаштовано.\n"
            "Додай <code>GOOGLE_CLIENT_ID</code> і <code>GOOGLE_CLIENT_SECRET</code> у файл .env "
            "і перезапусти бота.",
            reply_markup=main_menu(db_user),
        )
        return

    try:
        url = oauth.create_auth_url(db_user.telegram_id)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Failed to create auth url")
        await message.answer(f"Не вдалося створити посилання: {exc}")
        return

    await state.set_state(OAuthStates.waiting)
    await message.answer(
        "Натисни кнопку, увійди в Google і дозволь доступ до календаря.\n\n"
        "Якщо відкриваєш з телефону і сторінка після входу не відкрилась — "
        "скопіюй адресу з рядка браузера (або параметр <code>code=...</code>) "
        "і надішли її мені сюди.\n\n"
        "Чекаю підтвердження до 5 хвилин…",
        reply_markup=connect_calendar_kb(url),
    )

    ok = await oauth.wait_for_completion(db_user.telegram_id, timeout=300)
    await state.clear()
    user = await oauth.repo.get_user(db_user.telegram_id)
    if ok and user and user.calendar_connected:
        await message.answer(
            "Готово! Google Calendar підключено ✓\n"
            "Тепер можу показувати події, створювати записи і нагадувати.",
            reply_markup=main_menu(user),
        )
    else:
        await message.answer(
            "Час на авторизацію вийшов або її скасували.\n"
            "Натисни «Підключити календар» ще раз, коли будеш готовий/а.",
            reply_markup=main_menu(user or db_user),
        )


@router.message(OAuthStates.waiting, F.text)
async def oauth_paste_code(
    message: Message,
    state: FSMContext,
    db_user: User,
    oauth: GoogleOAuthService,
) -> None:
    if not message.text or message.text.startswith("❌"):
        await state.clear()
        await message.answer("Підключення скасовано.", reply_markup=main_menu(db_user))
        return

    code = oauth.extract_code(message.text)
    if not code:
        await message.answer(
            "Не бачу authorization code.\n"
            "Надішли повний URL після редіректу або сам параметр <code>code=...</code>."
        )
        return

    try:
        await message.answer("Код отримано, підключаю…")
        await oauth.complete_with_code(db_user.telegram_id, code)
    except Exception as exc:  # noqa: BLE001
        logger.exception("manual oauth failed")
        await message.answer(f"Не вдалося завершити авторизацію: {exc}")
        return

    # Якщо очікування вже скінчилось по таймауту — підтвердимо тут
    user = await oauth.repo.get_user(db_user.telegram_id)
    if user and user.calendar_connected:
        current = await state.get_state()
        if current == OAuthStates.waiting.state:
            await state.clear()
            await message.answer(
                "Готово! Google Calendar підключено ✓",
                reply_markup=main_menu(user),
            )



@router.callback_query(F.data == "oauth:cancel")
async def oauth_cancel(callback: CallbackQuery, state: FSMContext, db_user: User) -> None:
    await state.clear()
    if callback.message:
        await callback.message.edit_text("Підключення скасовано.")
        await callback.message.answer("Меню:", reply_markup=main_menu(db_user))
    await callback.answer()


@router.message(Command("events"))
@router.message(F.text == "📅 Найближчі")
async def list_events(
    message: Message,
    db_user: User,
    calendar: GoogleCalendarClient,
) -> None:
    if not db_user.calendar_connected:
        await message.answer(
            "Спочатку підключи Google Calendar.",
            reply_markup=main_menu(db_user),
        )
        return

    try:
        events = await calendar.list_upcoming(db_user, days=7, max_results=12)
    except Exception as exc:  # noqa: BLE001
        logger.exception("list events failed")
        await message.answer(f"Не вдалося отримати події: {exc}")
        return

    if not events:
        await message.answer(
            "На найближчі 7 днів подій немає.\nСтвори нову кнопкою ➕ Нова подія.",
            reply_markup=main_menu(db_user),
        )
        return

    lines = [f"<b>Найближчі події</b> (нагадування за {db_user.reminder_minutes} хв):\n"]
    for idx, event in enumerate(events, start=1):
        when = event.format_when(db_user.timezone)
        loc = f"\n   📍 {event.location}" if event.location else ""
        lines.append(f"{idx}. <b>{event.summary}</b>\n   🕒 {when}{loc}")

    await message.answer("\n\n".join(lines), reply_markup=main_menu(db_user))


@router.message(Command("status"))
async def status(message: Message, db_user: User, settings: Settings) -> None:
    cal = "підключено ✓" if db_user.calendar_connected else "не підключено"
    await message.answer(
        "<b>Статус EventPing</b>\n"
        f"• Календар: {cal}\n"
        f"• Часовий пояс: {db_user.timezone}\n"
        f"• Нагадування: за {db_user.reminder_minutes} хв\n"
        f"• Сховище: {settings.db_backend}",
        reply_markup=main_menu(db_user),
    )
