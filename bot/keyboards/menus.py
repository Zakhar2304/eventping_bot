from __future__ import annotations

from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup
from aiogram.utils.keyboard import InlineKeyboardBuilder, ReplyKeyboardBuilder

from bot.db.models import User


def main_menu(user: User | None = None) -> ReplyKeyboardMarkup:
    builder = ReplyKeyboardBuilder()
    builder.button(text="➕ Нова подія")
    builder.button(text="📅 Найближчі")
    builder.button(text="⏰ Нагадування")
    builder.button(text="⚙️ Налаштування")
    if user and user.calendar_connected:
        builder.button(text="🔗 Календар ✓")
    else:
        builder.button(text="🔗 Підключити календар")
    builder.button(text="ℹ️ Допомога")
    builder.adjust(2, 2, 1, 1)
    return builder.as_markup(resize_keyboard=True)


def connect_calendar_kb(auth_url: str) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.button(text="🔓 Відкрити Google", url=auth_url)
    builder.button(text="❌ Скасувати", callback_data="oauth:cancel")
    builder.adjust(1)
    return builder.as_markup()


def settings_kb(user: User) -> InlineKeyboardMarkup:
    builder = InlineKeyboardBuilder()
    builder.button(
        text=f"⏰ Нагадувати за {user.reminder_minutes} хв",
        callback_data="settings:reminder",
    )
    builder.button(
        text=f"🌍 Часовий пояс: {user.timezone}",
        callback_data="settings:timezone",
    )
    if user.calendar_connected:
        builder.button(text="🔌 Відключити календар", callback_data="settings:disconnect")
    else:
        builder.button(text="🔗 Підключити календар", callback_data="settings:connect")
    builder.button(text="« Назад", callback_data="settings:close")
    builder.adjust(1)
    return builder.as_markup()


def reminder_presets_kb(current: int) -> InlineKeyboardMarkup:
    presets = [5, 10, 15, 30, 60, 120, 1440]
    labels = {
        5: "5 хв",
        10: "10 хв",
        15: "15 хв",
        30: "30 хв",
        60: "1 год",
        120: "2 год",
        1440: "1 день",
    }
    builder = InlineKeyboardBuilder()
    for minutes in presets:
        mark = "✓ " if minutes == current else ""
        builder.button(
            text=f"{mark}{labels[minutes]}",
            callback_data=f"reminder:set:{minutes}",
        )
    builder.button(text="« Назад", callback_data="settings:open")
    builder.adjust(3, 3, 1, 1)
    return builder.as_markup()


def timezone_kb(current: str) -> InlineKeyboardMarkup:
    zones = [
        "Europe/Kyiv",
        "Europe/Warsaw",
        "Europe/Berlin",
        "Europe/London",
        "Europe/Prague",
        "UTC",
    ]
    builder = InlineKeyboardBuilder()
    for zone in zones:
        mark = "✓ " if zone == current else ""
        builder.button(text=f"{mark}{zone}", callback_data=f"tz:set:{zone}")
    builder.button(text="« Назад", callback_data="settings:open")
    builder.adjust(1)
    return builder.as_markup()


def confirm_event_kb() -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [
                InlineKeyboardButton(text="✅ Створити", callback_data="event:confirm"),
                InlineKeyboardButton(text="✏️ Змінити", callback_data="event:edit"),
            ],
            [InlineKeyboardButton(text="❌ Скасувати", callback_data="event:cancel")],
        ]
    )


def cancel_kb() -> ReplyKeyboardMarkup:
    builder = ReplyKeyboardBuilder()
    builder.button(text="❌ Скасувати")
    return builder.as_markup(resize_keyboard=True)
