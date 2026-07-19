from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from zoneinfo import ZoneInfo

from dateutil import parser as date_parser

WEEKDAYS_UA = {
    "понеділок": 0,
    "вівторок": 1,
    "среда": 2,
    "середа": 2,
    "четвер": 3,
    "пʼятниця": 4,
    "п'ятниця": 4,
    "пятниця": 4,
    "субота": 5,
    "неділя": 6,
}


@dataclass
class ParsedEventDraft:
    summary: str
    start: datetime
    end: datetime
    location: Optional[str] = None


def _next_weekday(now: datetime, weekday: int) -> datetime:
    days_ahead = (weekday - now.weekday()) % 7
    if days_ahead == 0:
        days_ahead = 7
    return (now + timedelta(days=days_ahead)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )


def parse_event_text(text: str, timezone_name: str) -> ParsedEventDraft:
    """
    Підтримує зручні формати:
      Завтра 15:00 Зустріч з клієнтом
      21.07 18:30 Вечеря @Кафе
      Через 2 години Дзвінок
      В п'ятницю 10:00 Планерка
      Сьогодні 09:30 Йога | зал 2
    """
    tz = ZoneInfo(timezone_name)
    now = datetime.now(tz)
    raw = " ".join(text.strip().split())
    if not raw:
        raise ValueError("Порожній текст події")

    location: Optional[str] = None
    working = raw
    loc_match = re.search(r"\s[@|]\s*(.+)$", working)
    if loc_match:
        location = loc_match.group(1).strip()
        working = working[: loc_match.start()].strip()

    start: Optional[datetime] = None
    title = working

    # Через N годин/хвилин
    m = re.match(
        r"^(через)\s+(\d+)\s*(хв|хвилин[уи]?|год|годин[уи]?|г)\s+(.+)$",
        working,
        flags=re.IGNORECASE,
    )
    if m:
        amount = int(m.group(2))
        unit = m.group(3).lower()
        title = m.group(4).strip()
        if unit.startswith("хв"):
            start = now + timedelta(minutes=amount)
        else:
            start = now + timedelta(hours=amount)

    # Сьогодні / Завтра / Післязавтра
    if start is None:
        m = re.match(
            r"^(сьогодні|завтра|післязавтра)\s+(\d{1,2})[:\.](\d{2})\s+(.+)$",
            working,
            flags=re.IGNORECASE,
        )
        if m:
            day_word, hour, minute, title = (
                m.group(1).lower(),
                int(m.group(2)),
                int(m.group(3)),
                m.group(4).strip(),
            )
            base = now.replace(hour=0, minute=0, second=0, microsecond=0)
            if day_word == "завтра":
                base += timedelta(days=1)
            elif day_word == "післязавтра":
                base += timedelta(days=2)
            start = base.replace(hour=hour, minute=minute)

    # В <день тижня> HH:MM Title
    if start is None:
        m = re.match(
            r"^(?:в|у)\s+([а-яіїєґʼ']+)\s+(\d{1,2})[:\.](\d{2})\s+(.+)$",
            working,
            flags=re.IGNORECASE,
        )
        if m:
            weekday_name = m.group(1).lower()
            if weekday_name in WEEKDAYS_UA:
                hour, minute = int(m.group(2)), int(m.group(3))
                title = m.group(4).strip()
                base = _next_weekday(now, WEEKDAYS_UA[weekday_name])
                start = base.replace(hour=hour, minute=minute)

    # DD.MM[.][YYYY] HH:MM Title
    if start is None:
        m = re.match(
            r"^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2})[:\.](\d{2})\s+(.+)$",
            working,
        )
        if m:
            day, month = int(m.group(1)), int(m.group(2))
            year = int(m.group(3)) if m.group(3) else now.year
            if year < 100:
                year += 2000
            hour, minute = int(m.group(4)), int(m.group(5))
            title = m.group(6).strip()
            start = datetime(year, month, day, hour, minute, tzinfo=tz)
            if start < now and not m.group(3):
                start = start.replace(year=now.year + 1)

    # HH:MM Title (сьогодні, або завтра якщо час минув)
    if start is None:
        m = re.match(r"^(\d{1,2})[:\.](\d{2})\s+(.+)$", working)
        if m:
            hour, minute = int(m.group(1)), int(m.group(2))
            title = m.group(3).strip()
            start = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if start <= now:
                start += timedelta(days=1)

    # Fallback: dateutil на перші токени
    if start is None:
        tokens = working.split()
        for take in range(min(4, len(tokens)), 0, -1):
            chunk = " ".join(tokens[:take])
            try:
                guessed = date_parser.parse(
                    chunk,
                    fuzzy=False,
                    dayfirst=True,
                    default=now.replace(hour=9, minute=0, second=0, microsecond=0),
                )
                if guessed.tzinfo is None:
                    guessed = guessed.replace(tzinfo=tz)
                else:
                    guessed = guessed.astimezone(tz)
                start = guessed
                title = " ".join(tokens[take:]).strip() or "Подія"
                break
            except (ValueError, OverflowError):
                continue

    if start is None:
        raise ValueError(
            "Не розпізнав дату/час.\n"
            "Приклади:\n"
            "• Завтра 15:00 Зустріч\n"
            "• 21.07 18:30 Вечеря\n"
            "• Через 2 години Дзвінок\n"
            "• В п'ятницю 10:00 Планерка"
        )

    title = title.strip(" -–|") or "Подія"
    if start.tzinfo is None:
        start = start.replace(tzinfo=tz)
    end = start + timedelta(hours=1)
    return ParsedEventDraft(summary=title, start=start, end=end, location=location)
