import { DbUser, getEnv, updateUser } from "./db.ts";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

export type CalendarEvent = {
  id: string;
  summary: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  htmlLink?: string;
  allDay: boolean;
};

export function oauthRedirectUri(): string {
  const base = getEnv("PUBLIC_BASE_URL") || getEnv("SUPABASE_URL");
  return `${base.replace(/\/$/, "")}/functions/v1/oauth-callback`;
}

export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getEnv("GOOGLE_CLIENT_ID"),
    redirect_uri: oauthRedirectUri(),
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/auth?${params}`;
}

export async function exchangeCode(code: string) {
  const body = new URLSearchParams({
    code,
    client_id: getEnv("GOOGLE_CLIENT_ID"),
    client_secret: getEnv("GOOGLE_CLIENT_SECRET"),
    redirect_uri: oauthRedirectUri(),
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || json.error || "token exchange failed");
  }
  return json as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
}

async function refreshAccessToken(
  db: SupabaseClient,
  user: DbUser,
): Promise<string> {
  if (!user.google_refresh_token) {
    throw new Error("Календар не підключено");
  }
  const expiry = user.google_token_expiry
    ? new Date(user.google_token_expiry).getTime()
    : 0;
  if (user.google_access_token && expiry > Date.now() + 60_000) {
    return user.google_access_token;
  }

  const body = new URLSearchParams({
    client_id: getEnv("GOOGLE_CLIENT_ID"),
    client_secret: getEnv("GOOGLE_CLIENT_SECRET"),
    refresh_token: user.google_refresh_token,
    grant_type: "refresh_token",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error_description || "Не вдалося оновити Google token");
  }
  const access = json.access_token as string;
  const expiresIn = Number(json.expires_in || 3600);
  const tokenExpiry = new Date(Date.now() + expiresIn * 1000).toISOString();
  await updateUser(db, user.telegram_id, {
    google_access_token: access,
    google_token_expiry: tokenExpiry,
  });
  return access;
}

function parseEvent(raw: Record<string, unknown>, tz: string): CalendarEvent | null {
  const startInfo = (raw.start || {}) as Record<string, string>;
  const endInfo = (raw.end || {}) as Record<string, string>;
  const allDay = !!startInfo.date && !startInfo.dateTime;
  try {
    const start = allDay
      ? new Date(`${startInfo.date}T00:00:00`)
      : new Date(startInfo.dateTime);
    const end = allDay
      ? new Date(`${endInfo.date}T00:00:00`)
      : new Date(endInfo.dateTime);
    return {
      id: String(raw.id),
      summary: String(raw.summary || "Без назви"),
      start,
      end,
      location: raw.location ? String(raw.location) : undefined,
      description: raw.description ? String(raw.description) : undefined,
      htmlLink: raw.htmlLink ? String(raw.htmlLink) : undefined,
      allDay,
    };
  } catch {
    return null;
  }
}

export function formatWhen(event: CalendarEvent, tz: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  };
  if (event.allDay) {
    return new Intl.DateTimeFormat("uk-UA", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    }).format(event.start) + " (цілий день)";
  }
  const start = new Intl.DateTimeFormat("uk-UA", opts).format(event.start);
  const endTime = new Intl.DateTimeFormat("uk-UA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(event.end);
  return `${start}–${endTime}`;
}

export async function listUpcoming(
  db: SupabaseClient,
  user: DbUser,
  daysOrOpts: number | { days?: number; maxResults?: number } = 7,
): Promise<CalendarEvent[]> {
  const opts = typeof daysOrOpts === "number"
    ? { days: daysOrOpts, maxResults: 12 }
    : {
      days: daysOrOpts.days ?? 7,
      maxResults: daysOrOpts.maxResults ?? 12,
    };
  const token = await refreshAccessToken(db, user);
  const now = new Date();
  // Start of "today" already covered by timeMin=now; fetch far ahead
  const timeMax = new Date(now.getTime() + opts.days * 86400_000);
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(user.calendar_id || "primary")
    }/events`,
  );
  url.searchParams.set("timeMin", now.toISOString());
  url.searchParams.set("timeMax", timeMax.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(Math.min(opts.maxResults, 250)));

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || "Calendar list failed");
  }
  const items = (json.items || []) as Record<string, unknown>[];
  return items
    .map((i) => parseEvent(i, user.timezone))
    .filter((e): e is CalendarEvent => !!e);
}

export type EventDraft = {
  summary: string;
  start: string;
  end: string;
  location?: string | null;
  description?: string | null;
};

export async function createEvent(
  db: SupabaseClient,
  user: DbUser,
  draft: EventDraft,
): Promise<CalendarEvent> {
  const token = await refreshAccessToken(db, user);
  const body: Record<string, unknown> = {
    summary: draft.summary,
    start: { dateTime: draft.start, timeZone: user.timezone },
    end: { dateTime: draft.end, timeZone: user.timezone },
  };
  if (draft.location) body.location = draft.location;
  if (draft.description) body.description = draft.description;

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(user.calendar_id || "primary")
    }/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || "Create event failed");
  }
  const parsed = parseEvent(json, user.timezone);
  if (!parsed) throw new Error("Не вдалося прочитати створену подію");
  return parsed;
}

export async function getEvent(
  db: SupabaseClient,
  user: DbUser,
  eventId: string,
): Promise<CalendarEvent> {
  const token = await refreshAccessToken(db, user);
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(user.calendar_id || "primary")
    }/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || "Get event failed");
  }
  const parsed = parseEvent(json, user.timezone);
  if (!parsed) throw new Error("Не вдалося прочитати подію");
  return parsed;
}

export async function updateEvent(
  db: SupabaseClient,
  user: DbUser,
  eventId: string,
  patch: Partial<EventDraft>,
): Promise<CalendarEvent> {
  const token = await refreshAccessToken(db, user);
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) {
    body.description = patch.description || "";
  }
  if (patch.location !== undefined) body.location = patch.location || "";
  if (patch.start) {
    body.start = { dateTime: patch.start, timeZone: user.timezone };
  }
  if (patch.end) {
    body.end = { dateTime: patch.end, timeZone: user.timezone };
  }

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(user.calendar_id || "primary")
    }/events/${encodeURIComponent(eventId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || "Update event failed");
  }
  const parsed = parseEvent(json, user.timezone);
  if (!parsed) throw new Error("Не вдалося прочитати оновлену подію");
  return parsed;
}

/** Civil date/time parts of an event in user timezone */
export function eventCivilParts(event: CalendarEvent, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const startParts = Object.fromEntries(
    fmt.formatToParts(event.start).map((p) => [p.type, p.value]),
  );
  const endParts = Object.fromEntries(
    fmt.formatToParts(event.end).map((p) => [p.type, p.value]),
  );
  const ymd = {
    y: Number(startParts.year),
    m: Number(startParts.month),
    d: Number(startParts.day),
  };
  const hour = Number(startParts.hour === "24" ? "0" : startParts.hour);
  const minute = Number(startParts.minute);
  const endH = Number(endParts.hour === "24" ? "0" : endParts.hour);
  const endM = Number(endParts.minute);
  let durationMin = (endH * 60 + endM) - (hour * 60 + minute);
  if (durationMin <= 0) durationMin = 60;
  return { ymd, hour, minute, durationMin };
}

export async function eventsNeedingReminder(
  db: SupabaseClient,
  user: DbUser,
  beforeMinutesList: number[],
  windowMinutes = 1,
  perEventOffsets: Record<string, number[]> = {},
): Promise<Array<{ event: CalendarEvent; remindAt: Date; minutesBefore: number }>> {
  const globalOffsets = beforeMinutesList.length
    ? beforeMinutesList
    : [user.reminder_minutes || 30];
  const allOffsets = [
    ...globalOffsets,
    ...Object.values(perEventOffsets).flat(),
  ];
  const maxBefore = Math.max(30, ...allOffsets);
  const token = await refreshAccessToken(db, user);
  const now = new Date();
  const lookAhead = new Date(
    now.getTime() + (maxBefore + windowMinutes + 1) * 60_000,
  );
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${
      encodeURIComponent(user.calendar_id || "primary")
    }/events`,
  );
  url.searchParams.set("timeMin", now.toISOString());
  url.searchParams.set("timeMax", lookAhead.toISOString());
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", "50");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.error?.message || "Calendar reminder fetch failed");
  }
  const items = (json.items || []) as Record<string, unknown>[];
  const due: Array<{ event: CalendarEvent; remindAt: Date; minutesBefore: number }> = [];
  for (const item of items) {
    const event = parseEvent(item, user.timezone);
    if (!event || event.allDay) continue;
    const custom = perEventOffsets[event.id];
    const offsets = custom?.length ? custom : globalOffsets;
    for (const minutesBefore of offsets) {
      const remindAt = new Date(event.start.getTime() - minutesBefore * 60_000);
      const deltaSec = (remindAt.getTime() - now.getTime()) / 1000;
      if (deltaSec >= -windowMinutes * 60 && deltaSec <= windowMinutes * 60) {
        due.push({ event, remindAt, minutesBefore });
      }
    }
  }
  return due;
}
