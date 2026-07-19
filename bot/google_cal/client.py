from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
from zoneinfo import ZoneInfo

from googleapiclient.discovery import build

from bot.db.models import User
from bot.google_cal.auth import GoogleOAuthService


@dataclass
class CalendarEvent:
    id: str
    summary: str
    start: datetime
    end: datetime
    location: Optional[str] = None
    description: Optional[str] = None
    html_link: Optional[str] = None
    all_day: bool = False

    def format_when(self, tz_name: str) -> str:
        tz = ZoneInfo(tz_name)
        if self.all_day:
            return self.start.astimezone(tz).strftime("%d.%m.%Y (цілий день)")
        local = self.start.astimezone(tz)
        end_local = self.end.astimezone(tz)
        if local.date() == end_local.date():
            return f"{local.strftime('%d.%m.%Y %H:%M')}–{end_local.strftime('%H:%M')}"
        return (
            f"{local.strftime('%d.%m.%Y %H:%M')} – "
            f"{end_local.strftime('%d.%m.%Y %H:%M')}"
        )


def _parse_event(raw: dict[str, Any], fallback_tz: str) -> Optional[CalendarEvent]:
    start_info = raw.get("start") or {}
    end_info = raw.get("end") or {}
    all_day = "date" in start_info and "dateTime" not in start_info

    try:
        if all_day:
            start = datetime.fromisoformat(start_info["date"]).replace(
                tzinfo=ZoneInfo(fallback_tz)
            )
            end = datetime.fromisoformat(end_info["date"]).replace(
                tzinfo=ZoneInfo(fallback_tz)
            )
        else:
            start = datetime.fromisoformat(
                start_info["dateTime"].replace("Z", "+00:00")
            )
            end = datetime.fromisoformat(end_info["dateTime"].replace("Z", "+00:00"))
    except (KeyError, ValueError):
        return None

    return CalendarEvent(
        id=raw["id"],
        summary=raw.get("summary") or "Без назви",
        start=start,
        end=end,
        location=raw.get("location"),
        description=raw.get("description"),
        html_link=raw.get("htmlLink"),
        all_day=all_day,
    )


class GoogleCalendarClient:
    def __init__(self, oauth: GoogleOAuthService) -> None:
        self.oauth = oauth

    async def _service(self, user: User):
        creds = await self.oauth.ensure_fresh_credentials(user)
        if not creds:
            raise RuntimeError("Календар не підключено")
        return await asyncio.to_thread(
            build, "calendar", "v3", credentials=creds, cache_discovery=False
        )

    async def list_upcoming(
        self, user: User, *, days: int = 7, max_results: int = 15
    ) -> list[CalendarEvent]:
        service = await self._service(user)
        now = datetime.now(timezone.utc)
        time_max = now + timedelta(days=days)

        def _fetch() -> list[dict[str, Any]]:
            result = (
                service.events()
                .list(
                    calendarId=user.calendar_id,
                    timeMin=now.isoformat(),
                    timeMax=time_max.isoformat(),
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=max_results,
                )
                .execute()
            )
            return result.get("items", [])

        items = await asyncio.to_thread(_fetch)
        events: list[CalendarEvent] = []
        for item in items:
            parsed = _parse_event(item, user.timezone)
            if parsed:
                events.append(parsed)
        return events

    async def create_event(
        self,
        user: User,
        *,
        summary: str,
        start: datetime,
        end: datetime,
        description: Optional[str] = None,
        location: Optional[str] = None,
    ) -> CalendarEvent:
        service = await self._service(user)
        tz = ZoneInfo(user.timezone)
        if start.tzinfo is None:
            start = start.replace(tzinfo=tz)
        else:
            start = start.astimezone(tz)
        if end.tzinfo is None:
            end = end.replace(tzinfo=tz)
        else:
            end = end.astimezone(tz)

        body: dict[str, Any] = {
            "summary": summary,
            "start": {"dateTime": start.isoformat(), "timeZone": user.timezone},
            "end": {"dateTime": end.isoformat(), "timeZone": user.timezone},
        }
        if description:
            body["description"] = description
        if location:
            body["location"] = location

        def _insert() -> dict[str, Any]:
            return (
                service.events()
                .insert(calendarId=user.calendar_id, body=body)
                .execute()
            )

        created = await asyncio.to_thread(_insert)
        parsed = _parse_event(created, user.timezone)
        if not parsed:
            raise RuntimeError("Не вдалося прочитати створену подію")
        return parsed

    async def events_needing_reminder(
        self, user: User, window_minutes: int = 5
    ) -> list[tuple[CalendarEvent, datetime]]:
        """Return events whose reminder time falls into [now-window, now+window]."""
        service = await self._service(user)
        now = datetime.now(timezone.utc)
        look_ahead = now + timedelta(minutes=user.reminder_minutes + window_minutes + 1)

        def _fetch() -> list[dict[str, Any]]:
            result = (
                service.events()
                .list(
                    calendarId=user.calendar_id,
                    timeMin=now.isoformat(),
                    timeMax=look_ahead.isoformat(),
                    singleEvents=True,
                    orderBy="startTime",
                    maxResults=50,
                )
                .execute()
            )
            return result.get("items", [])

        items = await asyncio.to_thread(_fetch)
        due: list[tuple[CalendarEvent, datetime]] = []
        for item in items:
            event = _parse_event(item, user.timezone)
            if not event or event.all_day:
                continue
            remind_at = event.start - timedelta(minutes=user.reminder_minutes)
            delta = (remind_at - now).total_seconds()
            if -window_minutes * 60 <= delta <= window_minutes * 60:
                due.append((event, remind_at))
        return due
