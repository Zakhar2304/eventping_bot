/** Date / time helpers for step-by-step event creation */

export type Ymd = { y: number; m: number; d: number };

export function nowParts(timeZone: string): Ymd & {
  h: number;
  mi: number;
  weekday: number;
  now: Date;
} {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const map: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    now,
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour === "24" ? "0" : parts.hour),
    mi: Number(parts.minute),
    weekday: map[parts.weekday] ?? now.getUTCDay(),
  };
}

export function addDaysYmd(base: Ymd, days: number): Ymd {
  const tmp = new Date(Date.UTC(base.y, base.m - 1, base.d));
  tmp.setUTCDate(tmp.getUTCDate() + days);
  return {
    y: tmp.getUTCFullYear(),
    m: tmp.getUTCMonth() + 1,
    d: tmp.getUTCDate(),
  };
}

export function nextWeekday(timeZone: string, target: number): Ymd {
  const ctx = nowParts(timeZone);
  let ahead = (target - ctx.weekday + 7) % 7;
  if (ahead === 0) ahead = 7;
  return addDaysYmd(ctx, ahead);
}

export function formatYmd(ymd: Ymd): string {
  return `${String(ymd.d).padStart(2, "0")}.${
    String(ymd.m).padStart(2, "0")
  }.${ymd.y}`;
}

export function parseDateText(text: string, timeZone: string): Ymd {
  const raw = text.trim();
  const ctx = nowParts(timeZone);

  let m = raw.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?$/);
  if (m) {
    const d = Number(m[1]);
    const month = Number(m[2]);
    let y = m[3] ? Number(m[3]) : ctx.y;
    if (y < 100) y += 2000;
    if (month < 1 || month > 12 || d < 1 || d > 31) {
      throw new Error("Невірна дата. Приклад: 20.07 або 20.07.2026");
    }
    let ymd = { y, m: month, d };
    // if date without year already passed this year → next year
    if (!m[3]) {
      const today = { y: ctx.y, m: ctx.m, d: ctx.d };
      if (cmpYmd(ymd, today) < 0) ymd = { ...ymd, y: y + 1 };
    }
    return ymd;
  }

  const lower = raw.toLowerCase();
  if (lower === "сьогодні") return { y: ctx.y, m: ctx.m, d: ctx.d };
  if (lower === "завтра") return addDaysYmd(ctx, 1);
  if (lower === "післязавтра") return addDaysYmd(ctx, 2);

  throw new Error("Не розпізнав дату. Приклади: 20.07, 20.07.2026, сьогодні");
}

/** Parse flexible time: 15, 15:00, 15 00, 8:30, 08:30, 8 30, 08 30, 15.00 */
export function parseTimeText(text: string): { hour: number; minute: number } {
  const raw = text.trim().replace(/\./g, ":");

  // 15:00 / 8:30 / 08:30
  let m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return validateTime(Number(m[1]), Number(m[2]));

  // 15 00 / 8 30 / 08 30
  m = raw.match(/^(\d{1,2})\s+(\d{2})$/);
  if (m) return validateTime(Number(m[1]), Number(m[2]));

  // bare hour: 15 or 8 → :00
  m = raw.match(/^(\d{1,2})$/);
  if (m) return validateTime(Number(m[1]), 0);

  throw new Error(
    "Не розпізнав час.\nПриклади: <code>15</code>, <code>15:00</code>, <code>15 00</code>, <code>8:30</code>, <code>8 30</code>, <code>08:30</code>",
  );
}

function validateTime(hour: number, minute: number) {
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error("Час має бути від 00:00 до 23:59");
  }
  return { hour, minute };
}

function cmpYmd(a: Ymd, b: Ymd): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

export function toIsoLocal(
  ymd: Ymd,
  hour: number,
  minute: number,
  timeZone: string,
): string {
  const utcGuess = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, hour, minute, 0));
  return formatInstantInZone(utcGuess, timeZone, ymd, hour, minute);
}

function formatInstantInZone(
  approx: Date,
  timeZone: string,
  ymd: Ymd,
  hour: number,
  minute: number,
): string {
  // Build offset for the target civil time in zone
  const probe = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, hour, minute, 0));
  // Adjust probe so that in timeZone it shows ymd+hour:minute
  for (let i = 0; i < 3; i++) {
    const p = nowPartsAt(probe, timeZone);
    const desired = Date.UTC(ymd.y, ymd.m - 1, ymd.d, hour, minute);
    const actual = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    probe.setTime(probe.getTime() + (desired - actual));
  }
  void approx;
  return toOffsetIso(probe, timeZone);
}

function nowPartsAt(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour === "24" ? "0" : parts.hour),
    mi: Number(parts.minute),
  };
}

function toOffsetIso(d: Date, timeZone: string): string {
  const p = nowPartsAt(d, timeZone);
  const offsetFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const tzName =
    offsetFmt.formatToParts(d).find((x) => x.type === "timeZoneName")?.value ||
    "GMT";
  let offset = "+00:00";
  const m = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (m) {
    const sign = m[1].startsWith("-") ? "-" : "+";
    const hours = Math.abs(Number(m[1])).toString().padStart(2, "0");
    const mins = (m[2] || "00").padStart(2, "0");
    offset = `${sign}${hours}:${mins}`;
  }
  const hour = String(p.h).padStart(2, "0");
  const minute = String(p.mi).padStart(2, "0");
  return `${p.y}-${String(p.m).padStart(2, "0")}-${
    String(p.d).padStart(2, "0")
  }T${hour}:${minute}:00${offset}`;
}

export function formatMinutes(mins: number): string {
  if (mins < 60) return `${mins} хв`;
  if (mins % 1440 === 0) {
    const d = mins / 1440;
    return d === 1 ? "1 день" : `${d} дні`;
  }
  if (mins % 60 === 0) {
    const h = mins / 60;
    return h === 1 ? "1 год" : `${h} год`;
  }
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} год ${m} хв`;
}

export function parseBeforeText(text: string): number {
  const raw = text.trim().toLowerCase();
  let m = raw.match(/^(\d+)\s*(хв|хвилин[уи]?|m|min)$/);
  if (m) return Number(m[1]);
  m = raw.match(/^(\d+)\s*(год|годин[уи]?|г|h)$/);
  if (m) return Number(m[1]) * 60;
  m = raw.match(/^(\d+)\s*(день|дні|дня|d)$/);
  if (m) return Number(m[1]) * 1440;
  m = raw.match(/^(\d+)$/);
  if (m) return Number(m[1]); // bare number = minutes
  throw new Error(
    "Приклади: <code>30</code>, <code>30 хв</code>, <code>2 год</code>, <code>1 день</code>",
  );
}
