import { addDaysYmd, nowParts, type Ymd } from "./datetime.ts";

const MONTHS_UA = [
  "Січень",
  "Лютий",
  "Березень",
  "Квітень",
  "Травень",
  "Червень",
  "Липень",
  "Серпень",
  "Вересень",
  "Жовтень",
  "Листопад",
  "Грудень",
];

const WEEKDAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];

type Btn = { text: string; callback_data: string };

function ymKey(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, "0")}`;
}

function shiftMonth(y: number, m: number, delta: number): { y: number; m: number } {
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
}

function cmpYmd(a: Ymd, b: Ymd): number {
  if (a.y !== b.y) return a.y - b.y;
  if (a.m !== b.m) return a.m - b.m;
  return a.d - b.d;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Monday-first offset of the 1st day (0 = Monday). */
function mondayOffset(y: number, m: number): number {
  const sun0 = new Date(Date.UTC(y, m - 1, 1)).getUTCDay(); // 0=Sun
  return (sun0 + 6) % 7;
}

/**
 * Nice month grid calendar for Telegram inline keyboard.
 */
export function monthCalendarKeyboard(
  year: number,
  month: number,
  timeZone: string,
) {
  const today = nowParts(timeZone);
  const todayYmd: Ymd = { y: today.y, m: today.m, d: today.d };
  const prev = shiftMonth(year, month, -1);
  const next = shiftMonth(year, month, 1);
  const title = `${MONTHS_UA[month - 1]} ${year}`;

  const rows: Btn[][] = [];

  rows.push([
    { text: "‹", callback_data: `cal:nav:${ymKey(prev.y, prev.m)}` },
    { text: `📅 ${title}`, callback_data: "cal:noop" },
    { text: "›", callback_data: `cal:nav:${ymKey(next.y, next.m)}` },
  ]);

  rows.push(
    WEEKDAYS.map((w) => ({ text: w, callback_data: "cal:noop" })),
  );

  const dim = daysInMonth(year, month);
  const offset = mondayOffset(year, month);
  let dayNum = 1 - offset;

  for (let week = 0; week < 6; week++) {
    const row: Btn[] = [];
    let hasReal = false;
    for (let wd = 0; wd < 7; wd++, dayNum++) {
      if (dayNum < 1 || dayNum > dim) {
        row.push({ text: "·", callback_data: "cal:noop" });
        continue;
      }
      hasReal = true;
      const ymd: Ymd = { y: year, m: month, d: dayNum };
      const isPast = cmpYmd(ymd, todayYmd) < 0;
      const isToday = cmpYmd(ymd, todayYmd) === 0;
      const key = `${year}-${String(month).padStart(2, "0")}-${
        String(dayNum).padStart(2, "0")
      }`;
      if (isPast) {
        // Visually muted — not selectable
        row.push({ text: `·${dayNum}`, callback_data: "cal:noop" });
      } else if (isToday) {
        row.push({ text: `•${dayNum}•`, callback_data: `cal:pick:${key}` });
      } else {
        row.push({ text: `${dayNum}`, callback_data: `cal:pick:${key}` });
      }
    }
    if (hasReal) rows.push(row);
    if (dayNum > dim) break;
  }

  rows.push([
    { text: "Сьогодні", callback_data: "cal:today" },
    { text: "Завтра", callback_data: "cal:tomorrow" },
  ]);
  rows.push([
    { text: "✍️ Ввести дату", callback_data: "cal:custom" },
    { text: "❌ Скасувати", callback_data: "event:cancel" },
  ]);

  return { inline_keyboard: rows };
}

export function calendarForTimezone(timeZone: string, y?: number, m?: number) {
  const now = nowParts(timeZone);
  return monthCalendarKeyboard(y ?? now.y, m ?? now.m, timeZone);
}

export function parseCalPick(data: string): Ymd | null {
  // cal:pick:2026-07-20
  const m = data.match(/^cal:pick:(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function parseCalNav(data: string): { y: number; m: number } | null {
  const m = data.match(/^cal:nav:(\d{4})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]) };
}

export { addDaysYmd };
