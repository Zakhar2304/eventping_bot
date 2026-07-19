export type ParsedEventDraft = {
  summary: string;
  start: string; // ISO
  end: string; // ISO
  location?: string;
};

const WEEKDAYS: Record<string, number> = {
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
};

function toIsoLocal(d: Date, timeZone: string): string {
  // Format as offset ISO using Intl parts in the user timezone
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).map((p) => [p.type, p.value]),
  );
  // Get offset for timezone at this instant
  const offsetFmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const tzName = offsetFmt.formatToParts(d).find((p) => p.type === "timeZoneName")
    ?.value || "GMT";
  let offset = "+00:00";
  const m = tzName.match(/GMT([+-]\d{1,2})(?::?(\d{2}))?/);
  if (m) {
    const sign = m[1].startsWith("-") ? "-" : "+";
    const hours = Math.abs(Number(m[1])).toString().padStart(2, "0");
    const mins = (m[2] || "00").padStart(2, "0");
    offset = `${sign}${hours}:${mins}`;
  } else if (tzName.includes("+")) {
    offset = tzName.replace("GMT", "").padEnd(6, ":00");
  }
  const hour = parts.hour === "24" ? "00" : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${offset}`;
}

function zonedDate(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  // Approximate: build UTC guess then adjust
  const utc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const asLocal = toIsoLocal(utc, timeZone);
  // Parse back roughly via Date
  return new Date(asLocal);
}

function nowInZone(timeZone: string): {
  now: Date;
  y: number;
  m: number;
  d: number;
  h: number;
  mi: number;
  weekday: number;
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

export function parseEventText(text: string, timeZone: string): ParsedEventDraft {
  const raw = text.trim().replace(/\s+/g, " ");
  if (!raw) throw new Error("Порожній текст події");

  let location: string | undefined;
  let working = raw;
  const locMatch = working.match(/\s[@|]\s*(.+)$/);
  if (locMatch) {
    location = locMatch[1].trim();
    working = working.slice(0, locMatch.index).trim();
  }

  const ctx = nowInZone(timeZone);
  let start: Date | null = null;
  let title = working;

  let m = working.match(
    /^(через)\s+(\d+)\s*(хв|хвилин[уи]?|год|годин[уи]?|г)\s+(.+)$/i,
  );
  if (m) {
    const amount = Number(m[2]);
    title = m[4].trim();
    const ms = m[3].toLowerCase().startsWith("хв")
      ? amount * 60_000
      : amount * 3_600_000;
    start = new Date(Date.now() + ms);
  }

  if (!start) {
    m = working.match(
      /^(сьогодні|завтра|післязавтра)\s+(\d{1,2})[:.](\d{2})\s+(.+)$/i,
    );
    if (m) {
      const dayWord = m[1].toLowerCase();
      const hour = Number(m[2]);
      const minute = Number(m[3]);
      title = m[4].trim();
      let add = 0;
      if (dayWord === "завтра") add = 1;
      if (dayWord === "післязавтра") add = 2;
      const tmp = new Date(Date.UTC(ctx.y, ctx.m - 1, ctx.d));
      tmp.setUTCDate(tmp.getUTCDate() + add);
      start = zonedDate(
        timeZone,
        tmp.getUTCFullYear(),
        tmp.getUTCMonth() + 1,
        tmp.getUTCDate(),
        hour,
        minute,
      );
    }
  }

  if (!start) {
    m = working.match(
      /^(?:в|у)\s+([а-яіїєґʼ']+)\s+(\d{1,2})[:.](\d{2})\s+(.+)$/i,
    );
    if (m) {
      const wd = m[1].toLowerCase();
      if (wd in WEEKDAYS) {
        const hour = Number(m[2]);
        const minute = Number(m[3]);
        title = m[4].trim();
        let daysAhead = (WEEKDAYS[wd] - ctx.weekday + 7) % 7;
        if (daysAhead === 0) daysAhead = 7;
        const tmp = new Date(Date.UTC(ctx.y, ctx.m - 1, ctx.d));
        tmp.setUTCDate(tmp.getUTCDate() + daysAhead);
        start = zonedDate(
          timeZone,
          tmp.getUTCFullYear(),
          tmp.getUTCMonth() + 1,
          tmp.getUTCDate(),
          hour,
          minute,
        );
      }
    }
  }

  if (!start) {
    m = working.match(
      /^(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s+(\d{1,2})[:.](\d{2})\s+(.+)$/,
    );
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      let year = m[3] ? Number(m[3]) : ctx.y;
      if (year < 100) year += 2000;
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      title = m[6].trim();
      start = zonedDate(timeZone, year, month, day, hour, minute);
      if (!m[3] && start.getTime() < Date.now()) {
        start = zonedDate(timeZone, year + 1, month, day, hour, minute);
      }
    }
  }

  if (!start) {
    m = working.match(/^(\d{1,2})[:.](\d{2})\s+(.+)$/);
    if (m) {
      const hour = Number(m[1]);
      const minute = Number(m[2]);
      title = m[3].trim();
      start = zonedDate(timeZone, ctx.y, ctx.m, ctx.d, hour, minute);
      if (start.getTime() <= Date.now()) {
        const tmp = new Date(Date.UTC(ctx.y, ctx.m - 1, ctx.d));
        tmp.setUTCDate(tmp.getUTCDate() + 1);
        start = zonedDate(
          timeZone,
          tmp.getUTCFullYear(),
          tmp.getUTCMonth() + 1,
          tmp.getUTCDate(),
          hour,
          minute,
        );
      }
    }
  }

  if (!start) {
    throw new Error(
      "Не розпізнав дату/час.\nПриклади:\n• Завтра 15:00 Зустріч\n• 21.07 18:30 Вечеря\n• Через 2 години Дзвінок\n• В п'ятницю 10:00 Планерка",
    );
  }

  title = title.replace(/^[-–|\s]+|[-–|\s]+$/g, "") || "Подія";
  const end = new Date(start.getTime() + 3_600_000);
  return {
    summary: title,
    start: toIsoLocal(start, timeZone),
    end: toIsoLocal(end, timeZone),
    location,
  };
}
