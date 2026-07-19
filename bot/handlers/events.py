from __future__ import annotations

import logging
import re
from datetime import datetime

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.fsm.context import FSMContext
from aiogram.types import CallbackQuery, Message

from bot.db.models import User
from bot.google_cal.client import GoogleCalendarClient
from bot.keyboards.menus import cancel_kb, confirm_event_kb, main_menu
from bot.services.event_parser import ParsedEventDraft, parse_event_text
from bot.states.forms import CreateEventStates

router = Router(name="events")
logger = logging.getLogger(__name__)

SMART_CREATE_RE = re.compile(
    r"^(завтра|сьогодні|післязавтра|через|в\s|у\s|\d{1,2}[.:]|\d{1,2}\.\d{1,2})",
    re.IGNORECASE,
)


def _draft_text(draft: ParsedEventDraft, timezone_name: str) -> str:
    start = draft.start
    end = draft.end
    when = start.strftime("%d.%m.%Y %H:%M")
    until = end.strftime("%H:%M")
    loc = f"\n📍 {draft.location}" if draft.location else ""
    return (
        "<b>Перевір подію</b>\n\n"
        f"📌 {draft.summary}\n"
        f"🕒 {when}–{until} ({timezone_name}){loc}\n\n"
        "Створити в Google Calendar?"
    )


def _draft_to_data(draft: ParsedEventDraft) -> dict:
    return {
        "summary": draft.summary,
        "start": draft.start.isoformat(),
        "end": draft.end.isoformat(),
        "location": draft.location,
    }


def _data_to_draft(data: dict) -> ParsedEventDraft:
    return ParsedEventDraft(
        summary=data["summary"],
        start=datetime.fromisoformat(data["start"]),
        end=datetime.fromisoformat(data["end"]),
        location=data.get("location"),
    )


@router.message(Command("add"))
@router.message(F.text == "➕ Нова подія")
async def start_create(message: Message, state: FSMContext, db_user: User) -> None:
    if not db_user.calendar_connected:
        await message.answer(
            "Спочатку підключи Google Calendar (кнопка 🔗).",
            reply_markup=main_menu(db_user),
        )
        return

    # /add Завтра 15:00 Зустріч
    if message.text and message.text.startswith("/add"):
        payload = message.text[4:].strip()
        if payload:
            await _try_parse_and_confirm(message, state, db_user, payload)
            return

    await state.set_state(CreateEventStates.waiting_text)
    await message.answer(
        "Напиши подію одним рядком.\n\n"
        "Приклади:\n"
        "• <code>Завтра 15:00 Зустріч з клієнтом</code>\n"
        "• <code>21.07 18:30 Вечеря @Кафе</code>\n"
        "• <code>Через 2 години Дзвінок</code>\n"
        "• <code>В п'ятницю 10:00 Планерка</code>",
        reply_markup=cancel_kb(),
    )


@router.message(CreateEventStates.waiting_text, F.text == "❌ Скасувати")
@router.message(CreateEventStates.confirming, F.text == "❌ Скасувати")
async def cancel_create(message: Message, state: FSMContext, db_user: User) -> None:
    await state.clear()
    await message.answer("Скасовано.", reply_markup=main_menu(db_user))


@router.message(CreateEventStates.waiting_text, F.text)
async def receive_event_text(
    message: Message, state: FSMContext, db_user: User
) -> None:
    assert message.text is not None
    await _try_parse_and_confirm(message, state, db_user, message.text)


async def _try_parse_and_confirm(
    message: Message, state: FSMContext, db_user: User, text: str
) -> None:
    try:
        draft = parse_event_text(text, db_user.timezone)
    except ValueError as exc:
        await message.answer(str(exc))
        await state.set_state(CreateEventStates.waiting_text)
        return

    await state.set_state(CreateEventStates.confirming)
    await state.update_data(draft=_draft_to_data(draft))
    await message.answer(
        _draft_text(draft, db_user.timezone),
        reply_markup=confirm_event_kb(),
    )


@router.callback_query(CreateEventStates.confirming, F.data == "event:confirm")
async def confirm_event(
    callback: CallbackQuery,
    state: FSMContext,
    db_user: User,
    calendar: GoogleCalendarClient,
) -> None:
    data = await state.get_data()
    draft_data = data.get("draft")
    if not draft_data:
        await callback.answer("Немає даних події", show_alert=True)
        return

    draft = _data_to_draft(draft_data)
    try:
        created = await calendar.create_event(
            db_user,
            summary=draft.summary,
            start=draft.start,
            end=draft.end,
            location=draft.location,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("create event failed")
        await callback.answer("Помилка створення", show_alert=True)
        if callback.message:
            await callback.message.answer(f"Не вдалося створити подію: {exc}")
        return

    await state.clear()
    link = f'\n<a href="{created.html_link}">Відкрити в Google Calendar</a>' if created.html_link else ""
    if callback.message:
        await callback.message.edit_text(
            f"Створено ✓\n\n"
            f"📌 <b>{created.summary}</b>\n"
            f"🕒 {created.format_when(db_user.timezone)}"
            f"{link}"
        )
        await callback.message.answer(
            f"Нагадаю за {db_user.reminder_minutes} хв до початку.",
            reply_markup=main_menu(db_user),
        )
    await callback.answer("Готово")


@router.callback_query(CreateEventStates.confirming, F.data == "event:edit")
async def edit_event(callback: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(CreateEventStates.waiting_text)
    if callback.message:
        await callback.message.edit_text("Ок, надішли новий текст події.")
        await callback.message.answer("Чекаю на текст:", reply_markup=cancel_kb())
    await callback.answer()


@router.callback_query(CreateEventStates.confirming, F.data == "event:cancel")
async def cancel_event_cb(
    callback: CallbackQuery, state: FSMContext, db_user: User
) -> None:
    await state.clear()
    if callback.message:
        await callback.message.edit_text("Скасовано.")
        await callback.message.answer("Меню:", reply_markup=main_menu(db_user))
    await callback.answer()


@router.message(F.text.func(lambda t: bool(t and SMART_CREATE_RE.match(t))))
async def smart_create_from_chat(
    message: Message, state: FSMContext, db_user: User
) -> None:
    """Allow creating events by typing naturally without pressing the button."""
    current = await state.get_state()
    if current is not None:
        return
    if not db_user.calendar_connected or not message.text:
        return
    if message.text.startswith(("➕", "📅", "⏰", "⚙️", "🔗", "ℹ️", "/")):
        return
    await _try_parse_and_confirm(message, state, db_user, message.text)
