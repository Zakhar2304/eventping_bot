import {
  addAbsoluteReminder,
  addBeforeReminder,
  addEventReminder,
  adminClient,
  clearSession,
  deleteReminderRule,
  getSession,
  getUser,
  listEventReminders,
  listReminderRules,
  removeEventReminder,
  setEventReminders,
  setSession,
  updateUser,
  upsertUser,
  type ReminderRule,
} from "../_shared/db.ts";
import {
  calendarForTimezone,
  monthCalendarKeyboard,
  parseCalNav,
  parseCalPick,
} from "../_shared/calendar_kb.ts";
import {
  addDaysYmd,
  formatMinutes,
  formatYmd,
  nowParts,
  parseBeforeText,
  parseDateText,
  parseTimeText,
  toIsoLocal,
  type Ymd,
} from "../_shared/datetime.ts";
import {
  buildAuthUrl,
  createEvent,
  eventCivilParts,
  formatWhen,
  getEvent,
  listUpcoming,
  oauthRedirectUri,
  updateEvent,
  type CalendarEvent,
} from "../_shared/google.ts";
import {
  answerCallback,
  cancelKeyboard,
  editMessageText,
  mainKeyboard,
  sendMessage,
  type Update,
} from "../_shared/telegram.ts";

const HELP =
  `<b>EventPing</b> — нагадування та події з Google Calendar.\n\n` +
  `<b>Нова подія:</b> дата → час → назва, далі можна відредагувати назву/час/дату/опис/нагадування.\n` +
  `<b>Редагування:</b> кнопка <b>✏️ Редагувати подію</b> — усі події від сьогодні.\n` +
  `Час: <code>15</code>, <code>15:00</code>, <code>15 00</code>, <code>8:30</code>, <code>8 30</code>.`;

const EDIT_PAGE_SIZE = 8;

function connected(u: { google_refresh_token: string | null }) {
  return !!u.google_refresh_token;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dateKeyboard(timeZone: string, y?: number, m?: number) {
  return calendarForTimezone(timeZone, y, m);
}

function confirmKb() {
  return {
    inline_keyboard: [
      [{ text: "✅ Створити", callback_data: "event:confirm" }],
      [
        { text: "✏️ Назва", callback_data: "cedit:title" },
        { text: "🕒 Час", callback_data: "cedit:time" },
      ],
      [
        { text: "📅 Дата", callback_data: "cedit:date" },
        { text: "📝 Опис", callback_data: "cedit:desc" },
      ],
      [{ text: "⏰ Нагадування", callback_data: "cedit:rem" }],
      [
        { text: "🔄 Спочатку", callback_data: "event:restart" },
        { text: "❌ Скасувати", callback_data: "event:cancel" },
      ],
    ],
  };
}

function eventEditKb() {
  return {
    inline_keyboard: [
      [
        { text: "✏️ Назва", callback_data: "eedit:title" },
        { text: "🕒 Час", callback_data: "eedit:time" },
      ],
      [
        { text: "📅 Дата", callback_data: "eedit:date" },
        { text: "📝 Опис", callback_data: "eedit:desc" },
      ],
      [{ text: "⏰ Нагадування перед подією", callback_data: "eedit:rem" }],
      [{ text: "« До списку", callback_data: "evlist" }],
    ],
  };
}

function eventsListKb(
  events: CalendarEvent[],
  page: number,
  total: number,
) {
  const pageSize = EDIT_PAGE_SIZE;
  const start = page * pageSize;
  const slice = events.slice(start, start + pageSize);
  const rows = slice.map((e, i) => {
    const idx = start + i;
    const when = new Intl.DateTimeFormat("uk-UA", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(e.start);
    return [{
      text: `✏️ ${idx + 1}. ${when} ${e.summary.slice(0, 22)}`,
      callback_data: `evopen:${idx}`,
    }];
  });
  const nav: Array<{ text: string; callback_data: string }> = [];
  if (page > 0) {
    nav.push({ text: "‹ Назад", callback_data: `evpage:${page - 1}` });
  }
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  if (page < maxPage) {
    nav.push({ text: "Далі ›", callback_data: `evpage:${page + 1}` });
  }
  if (nav.length) rows.push(nav);
  rows.push([{ text: "🔄 Оновити список", callback_data: "evlist" }]);
  return { inline_keyboard: rows };
}

function draftRemindersKb(mins: number[]) {
  const rows = [
    [{ text: "➕ Додати інтервал", callback_data: "drem:add" }],
    ...mins.map((m) => [{
      text: `🗑 За ${formatMinutes(m)}`,
      callback_data: `drem:del:${m}`,
    }]),
    [{ text: "« Назад до події", callback_data: "cedit:back" }],
  ];
  return { inline_keyboard: rows };
}

function eventRemindersKb(mins: number[]) {
  return {
    inline_keyboard: [
      [{ text: "➕ Додати інтервал", callback_data: "erem:add" }],
      ...mins.map((m) => [{
        text: `🗑 За ${formatMinutes(m)}`,
        callback_data: `erem:del:${m}`,
      }]),
      [{
        text: mins.length ? "↩️ Як у загальних налаштуваннях" : "✓ Загальні налаштування",
        callback_data: "erem:reset",
      }],
      [{ text: "« Назад", callback_data: "eedit:back" }],
    ],
  };
}

function remAddPresetsKb(prefix: "drem" | "erem") {
  const presets = [5, 15, 30, 60, 120, 1440] as const;
  const labels: Record<number, string> = {
    5: "5 хв",
    15: "15 хв",
    30: "30 хв",
    60: "1 год",
    120: "2 год",
    1440: "1 день",
  };
  return {
    inline_keyboard: [
      presets.slice(0, 3).map((m) => ({
        text: labels[m],
        callback_data: `${prefix}:set:${m}`,
      })),
      presets.slice(3).map((m) => ({
        text: labels[m],
        callback_data: `${prefix}:set:${m}`,
      })),
      [{ text: "✏️ Свій…", callback_data: `${prefix}:custom` }],
      [{
        text: "« Назад",
        callback_data: prefix === "drem" ? "cedit:rem" : "eedit:rem",
      }],
    ],
  };
}

function timezoneKb(current: string) {
  const zones = [
    "Europe/Kyiv",
    "Europe/Warsaw",
    "Europe/Berlin",
    "Europe/London",
    "UTC",
  ];
  return {
    inline_keyboard: [
      ...zones.map((z) => [{
        text: `${z === current ? "✓ " : ""}${z}`,
        callback_data: `tz:${z}`,
      }]),
      [{ text: "« Назад", callback_data: "settings:open" }],
    ],
  };
}

function formatRule(rule: ReminderRule, tz: string): string {
  if (rule.kind === "before" && rule.minutes_before != null) {
    return `⏱ за ${formatMinutes(rule.minutes_before)} до події`;
  }
  if (rule.kind === "absolute" && rule.absolute_at) {
    const d = new Date(rule.absolute_at);
    const when = new Intl.DateTimeFormat("uk-UA", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
    const title = rule.title ? ` — ${rule.title}` : "";
    return `📅 ${when}${title}`;
  }
  return "—";
}

async function remindersText(
  db: ReturnType<typeof adminClient>,
  telegramId: number,
  tz: string,
) {
  const rules = await listReminderRules(db, telegramId);
  if (!rules.length) {
    return "<b>Нагадування</b>\n\nПоки немає жодного. Додай нижче.";
  }
  const lines = rules.map((r, i) => `${i + 1}. ${formatRule(r, tz)}`);
  return `<b>Нагадування</b>\n\n${lines.join("\n")}`;
}

function remindersKb(rules: ReminderRule[]) {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [
    [{ text: "➕ За скільки до події", callback_data: "rem:add_before" }],
    [{ text: "➕ Точна дата і час", callback_data: "rem:add_abs" }],
  ];
  for (const r of rules.slice(0, 8)) {
    const label = r.kind === "before"
      ? `🗑 За ${formatMinutes(r.minutes_before || 0)}`
      : `🗑 ${r.title || "Точне"}`;
    rows.push([{ text: label, callback_data: `rem:del:${r.id}` }]);
  }
  rows.push([{ text: "« Налаштування", callback_data: "settings:open" }]);
  return { inline_keyboard: rows };
}

function beforePresetsKb() {
  const presets = [
    [5, "5 хв"],
    [10, "10 хв"],
    [15, "15 хв"],
    [30, "30 хв"],
    [60, "1 год"],
    [120, "2 год"],
    [1440, "1 день"],
    [2880, "2 дні"],
  ] as const;
  const rows = [];
  for (let i = 0; i < presets.length; i += 3) {
    rows.push(
      presets.slice(i, i + 3).map(([m, l]) => ({
        text: l,
        callback_data: `rem:before:${m}`,
      })),
    );
  }
  rows.push([{ text: "✏️ Свій варіант…", callback_data: "rem:before_custom" }]);
  rows.push([{ text: "« Назад", callback_data: "rem:open" }]);
  return { inline_keyboard: rows };
}

async function settingsText(
  db: ReturnType<typeof adminClient>,
  u: {
    telegram_id: number;
    google_refresh_token: string | null;
    timezone: string;
  },
) {
  const cal = u.google_refresh_token ? "підключено ✓" : "не підключено";
  const rules = await listReminderRules(db, u.telegram_id);
  const before = rules.filter((r) => r.kind === "before").length;
  const abs = rules.filter((r) => r.kind === "absolute").length;
  return (
    `<b>Налаштування</b>\n\n🔗 Календар: ${cal}\n` +
    `⏰ Нагадування: ${before} «до події», ${abs} точних\n` +
    `🌍 Часовий пояс: ${u.timezone}`
  );
}

function settingsKb(isConn: boolean) {
  return {
    inline_keyboard: [
      [{ text: "⏰ Нагадування", callback_data: "rem:open" }],
      [{ text: "🌍 Часовий пояс", callback_data: "settings:timezone" }],
      isConn
        ? [{ text: "🔌 Відключити календар", callback_data: "settings:disconnect" }]
        : [{ text: "🔗 Підключити календар", callback_data: "connect" }],
    ],
  };
}

Deno.serve(async (req) => {
  if (req.method === "GET") {
    return new Response("eventping telegram-webhook ok", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const update = (await req.json()) as Update;
    const db = adminClient();
    if (update.callback_query) {
      await handleCallback(db, update);
      return json({ ok: true });
    }
    if (update.message?.from && update.message.text) {
      await handleMessage(db, update);
      return json({ ok: true });
    }
    return json({ ok: true });
  } catch (err) {
    console.error(err);
    return json({ ok: false, error: String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function startCreateFlow(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  telegramId: number,
  timeZone: string,
) {
  await setSession(db, telegramId, "create_date", {});
  await sendMessage(
    chatId,
    "<b>Нова подія</b>\nОбери день у календарі 👇\n<i>•сьогодні• — обведено крапками</i>",
    { reply_markup: dateKeyboard(timeZone) },
  );
}

async function sendEventsList(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  user: Parameters<typeof listUpcoming>[1],
  opts: {
    editMessageId?: number;
    page?: number;
    mode?: "view" | "edit";
    reuseIds?: string[];
  } = {},
) {
  const mode = opts.mode ?? "edit";
  const page = opts.page ?? 0;
  const pageSize = EDIT_PAGE_SIZE;

  let events: CalendarEvent[];
  if (opts.reuseIds?.length && opts.page !== undefined) {
    // Re-fetch full list to stay in sync, but keep paging
    events = await listUpcoming(db, user, { days: 120, maxResults: 100 });
  } else {
    events = await listUpcoming(db, user, {
      days: mode === "edit" ? 120 : 14,
      maxResults: mode === "edit" ? 100 : 20,
    });
  }

  if (!events.length) {
    const text =
      "Подій від сьогодні немає.\nСтвори нову кнопкою ➕ Нова подія.";
    if (opts.editMessageId) {
      await editMessageText(chatId, opts.editMessageId, text);
      await sendMessage(chatId, "Меню:", { reply_markup: mainKeyboard(true) });
    } else {
      await sendMessage(chatId, text, { reply_markup: mainKeyboard(true) });
    }
    await clearSession(db, user.telegram_id);
    return;
  }

  const total = events.length;
  const maxPage = Math.max(0, Math.ceil(total / pageSize) - 1);
  const safePage = Math.min(Math.max(0, page), maxPage);
  const start = safePage * pageSize;
  const slice = events.slice(start, start + pageSize);

  const header = mode === "edit"
    ? `<b>✏️ Редагування подій</b>\nУсі події від сьогодні (${total}). Обери подію:\n` +
      `<i>Сторінка ${safePage + 1}/${maxPage + 1}</i>\n`
    : `<b>📅 Найближчі події</b>\nНатисни ✏️ щоб редагувати:\n`;

  const lines = [header];
  slice.forEach((e, i) => {
    const idx = start + i;
    const loc = e.location ? `\n   📍 ${e.location}` : "";
    const desc = e.description
      ? `\n   📝 ${escapeHtml(e.description.slice(0, 60))}`
      : "";
    lines.push(
      `${idx + 1}. <b>${escapeHtml(e.summary)}</b>\n   🕒 ${
        formatWhen(e, user.timezone)
      }${loc}${desc}`,
    );
  });

  await setSession(db, user.telegram_id, "events_list", {
    listIds: events.map((e) => e.id),
    page: safePage,
    mode,
  });

  const text = lines.join("\n\n");
  const kb = eventsListKb(events, safePage, total);
  if (opts.editMessageId) {
    await editMessageText(chatId, opts.editMessageId, text, {
      reply_markup: kb,
    });
  } else {
    await sendMessage(chatId, text, { reply_markup: kb });
  }
}

async function showEventRemindersScreen(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  user: { telegram_id: number; timezone: string },
  event: CalendarEvent,
  opts: { editMessageId?: number } = {},
) {
  const mins = await listEventReminders(db, user.telegram_id, event.id);
  const text =
    `<b>Нагадування перед подією</b>\n📌 ${escapeHtml(event.summary)}\n\n` +
    (mins.length
      ? mins.map((m, i) => `${i + 1}. за ${formatMinutes(m)}`).join("\n")
      : "Зараз: <i>загальні налаштування акаунта</i>");
  await setSession(db, user.telegram_id, "edit_event", {
    eventId: event.id,
    listIds: (await getSession(db, user.telegram_id))?.data?.listIds || [],
  });
  if (opts.editMessageId) {
    await editMessageText(chatId, opts.editMessageId, text, {
      reply_markup: eventRemindersKb(mins),
    });
  } else {
    await sendMessage(chatId, text, { reply_markup: eventRemindersKb(mins) });
  }
}

async function askTime(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  telegramId: number,
  ymd: Ymd,
  sessionData: Record<string, unknown> = {},
) {
  await setSession(db, telegramId, "create_time", { ...sessionData, ymd });
  await sendMessage(
    chatId,
    `<b>Крок 2/3 — час</b>\nДата: <b>${formatYmd(ymd)}</b>\n\n` +
      `Напиши час. Підходять формати:\n` +
      `• <code>15</code> або <code>15:00</code> або <code>15 00</code>\n` +
      `• <code>8:30</code>, <code>08:30</code>, <code>8 30</code>, <code>08 30</code>`,
    { reply_markup: cancelKeyboard() },
  );
}

async function askTitle(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  telegramId: number,
  data: Record<string, unknown>,
) {
  await setSession(db, telegramId, "create_title", data);
  const ymd = data.ymd as Ymd;
  const time = data.time as string;
  await sendMessage(
    chatId,
    `<b>Крок 3/3 — назва</b>\n📅 ${formatYmd(ymd)} о <b>${time}</b>\n\n` +
      `Напиши назву події (наприклад: <i>Зустріч з клієнтом</i>)`,
    { reply_markup: cancelKeyboard() },
  );
}

function buildDraftFromData(
  data: Record<string, unknown>,
  timezone: string,
) {
  const ymd = data.ymd as Ymd;
  const hour = Number(data.hour);
  const minute = Number(data.minute);
  const title = String(data.title || "Подія");
  const description = data.description ? String(data.description) : "";
  const durationMin = Number(data.durationMin || 60);
  const start = toIsoLocal(ymd, hour, minute, timezone);
  const endTotal = hour * 60 + minute + durationMin;
  const endDayAdd = Math.floor(endTotal / (24 * 60));
  const endMins = endTotal % (24 * 60);
  const endHour = Math.floor(endMins / 60);
  const endMinute = endMins % 60;
  const endYmd = endDayAdd ? addDaysYmd(ymd, endDayAdd) : ymd;
  const end = toIsoLocal(endYmd, endHour, endMinute, timezone);
  return {
    summary: title,
    start,
    end,
    description: description || null,
  };
}

function confirmText(data: Record<string, unknown>, timezone: string) {
  const ymd = data.ymd as Ymd;
  const hour = Number(data.hour);
  const minute = Number(data.minute);
  const title = String(data.title || "Подія");
  const description = data.description ? String(data.description) : "";
  const reminders = (data.reminders as number[] | undefined) || [];
  const remLine = reminders.length
    ? reminders.map((m) => `за ${formatMinutes(m)}`).join(", ")
    : "як у загальних налаштуваннях";
  const descLine = description
    ? `\n📝 ${escapeHtml(description)}`
    : "\n📝 <i>без опису</i>";
  void timezone;
  return (
    `<b>Перевір подію</b>\n\n` +
    `📌 ${escapeHtml(title)}\n` +
    `📅 ${formatYmd(ymd)}\n` +
    `🕒 ${String(hour).padStart(2, "0")}:${
      String(minute).padStart(2, "0")
    }${descLine}\n` +
    `⏰ Нагадування: ${remLine}\n\n` +
    `Можеш відредагувати поля кнопками нижче або створити.`
  );
}

async function showConfirm(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  telegramId: number,
  timezone: string,
  data: Record<string, unknown>,
  opts: { editMessageId?: number } = {},
) {
  const draft = buildDraftFromData(data, timezone);
  const payload = {
    ...data,
    durationMin: Number(data.durationMin || 60),
    reminders: (data.reminders as number[]) || [],
    draft,
  };
  await setSession(db, telegramId, "create_confirm", payload);
  const text = confirmText(payload, timezone);
  if (opts.editMessageId) {
    await editMessageText(chatId, opts.editMessageId, text, {
      reply_markup: confirmKb(),
    });
  } else {
    await sendMessage(chatId, text, { reply_markup: confirmKb() });
  }
}

async function showExistingEdit(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  user: { telegram_id: number; timezone: string },
  event: CalendarEvent,
  opts: { editMessageId?: number; listIds?: string[] } = {},
) {
  const prev = await getSession(db, user.telegram_id);
  const listIds = opts.listIds ??
    (prev?.data?.listIds as string[] | undefined) ??
    [];
  const parts = eventCivilParts(event, user.timezone);
  const rem = await listEventReminders(db, user.telegram_id, event.id);
  const remLine = rem.length
    ? rem.map((m) => `за ${formatMinutes(m)}`).join(", ")
    : "як у загальних налаштуваннях";
  const desc = event.description
    ? `\n📝 ${escapeHtml(event.description)}`
    : "\n📝 <i>без опису</i>";
  const text =
    `<b>Редагування події</b>\n\n` +
    `📌 ${escapeHtml(event.summary)}\n` +
    `📅 ${formatYmd(parts.ymd)}\n` +
    `🕒 ${String(parts.hour).padStart(2, "0")}:${
      String(parts.minute).padStart(2, "0")
    }${desc}\n` +
    `⏰ Нагадування: ${remLine}`;

  await setSession(db, user.telegram_id, "edit_event", {
    eventId: event.id,
    listIds,
    mode: prev?.data?.mode || "edit",
    page: prev?.data?.page || 0,
  });

  if (opts.editMessageId) {
    await editMessageText(chatId, opts.editMessageId, text, {
      reply_markup: eventEditKb(),
    });
  } else {
    await sendMessage(chatId, text, { reply_markup: eventEditKb() });
  }
}

async function handleMessage(
  db: ReturnType<typeof adminClient>,
  update: Update,
) {
  const msg = update.message!;
  const from = msg.from!;
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const user = await upsertUser(db, from);
  const session = await getSession(db, user.telegram_id);
  const isConn = connected(user);

  if (text === "/start") {
    await clearSession(db, user.telegram_id);
    const name = user.first_name || "там";
    const status = isConn
      ? "Календар уже підключено ✓"
      : "Спочатку підключи Google Calendar — кнопка нижче.";
    await sendMessage(
      chatId,
      `Привіт, ${name}! Я <b>EventPing</b> 👋\n\n${status}`,
      { reply_markup: mainKeyboard(isConn) },
    );
    return;
  }

  if (text === "/help" || text === "ℹ️ Допомога") {
    await sendMessage(chatId, HELP, { reply_markup: mainKeyboard(isConn) });
    return;
  }

  if (text === "❌ Скасувати") {
    await clearSession(db, user.telegram_id);
    await sendMessage(chatId, "Скасовано.", {
      reply_markup: mainKeyboard(isConn),
    });
    return;
  }

  if (
    text === "/connect" ||
    text === "🔗 Підключити календар" ||
    text === "🔗 Календар ✓"
  ) {
    if (text === "🔗 Календар ✓" && isConn) {
      await sendMessage(
        chatId,
        "Google Calendar уже підключено.\nВідключити можна в ⚙️ Налаштування.",
        { reply_markup: mainKeyboard(true) },
      );
      return;
    }
    await startConnect(db, chatId, user.telegram_id);
    return;
  }

  if (text === "/events" || text === "📅 Найближчі") {
    if (!isConn) {
      await sendMessage(chatId, "Спочатку підключи Google Calendar.", {
        reply_markup: mainKeyboard(false),
      });
      return;
    }
    try {
      await sendEventsList(db, chatId, user, { mode: "view" });
    } catch (e) {
      await sendMessage(chatId, `Не вдалося отримати події: ${e}`);
    }
    return;
  }

  if (
    text === "/edit" ||
    text === "✏️ Редагувати подію" ||
    text === "✏️ Редагувати"
  ) {
    if (!isConn) {
      await sendMessage(chatId, "Спочатку підключи Google Calendar.", {
        reply_markup: mainKeyboard(false),
      });
      return;
    }
    try {
      await sendEventsList(db, chatId, user, { mode: "edit", page: 0 });
    } catch (e) {
      await sendMessage(chatId, `Не вдалося отримати події: ${e}`);
    }
    return;
  }

  if (
    text === "/settings" || text === "⚙️ Налаштування" || text === "⏰ Нагадування"
  ) {
    if (text === "⏰ Нагадування") {
      const rules = await listReminderRules(db, user.telegram_id);
      await sendMessage(
        chatId,
        await remindersText(db, user.telegram_id, user.timezone),
        { reply_markup: remindersKb(rules) },
      );
      return;
    }
    await sendMessage(chatId, await settingsText(db, user), {
      reply_markup: settingsKb(isConn),
    });
    return;
  }

  if (text === "/add" || text === "➕ Нова подія") {
    if (!isConn) {
      await sendMessage(chatId, "Спочатку підключи Google Calendar.", {
        reply_markup: mainKeyboard(false),
      });
      return;
    }
    await startCreateFlow(db, chatId, user.telegram_id, user.timezone);
    return;
  }

  // --- wizard text states ---
  if (session?.state === "create_date_custom") {
    try {
      const ymd = parseDateText(text, user.timezone);
      if (session.data?.returnTo === "create_confirm") {
        await showConfirm(db, chatId, user.telegram_id, user.timezone, {
          ...(session.data || {}),
          ymd,
        });
      } else {
        await askTime(db, chatId, user.telegram_id, ymd, session.data || {});
      }
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "create_time") {
    try {
      const { hour, minute } = parseTimeText(text);
      const time =
        `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
      const next = { ...(session.data || {}), hour, minute, time };
      if (session.data?.returnTo === "create_confirm") {
        await showConfirm(db, chatId, user.telegram_id, user.timezone, next);
      } else {
        await askTitle(db, chatId, user.telegram_id, next);
      }
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "create_title") {
    const title = text.replace(/\s+/g, " ").trim();
    if (!title) {
      await sendMessage(chatId, "Назва не може бути порожньою.");
      return;
    }
    await showConfirm(db, chatId, user.telegram_id, user.timezone, {
      ...(session.data || {}),
      title,
    });
    return;
  }

  if (session?.state === "create_edit_title") {
    const title = text.replace(/\s+/g, " ").trim();
    if (!title) {
      await sendMessage(chatId, "Назва не може бути порожньою.");
      return;
    }
    await showConfirm(db, chatId, user.telegram_id, user.timezone, {
      ...(session.data || {}),
      title,
    });
    return;
  }

  if (session?.state === "create_edit_desc") {
    const description = text === "-" ? "" : text.trim();
    await showConfirm(db, chatId, user.telegram_id, user.timezone, {
      ...(session.data || {}),
      description,
    });
    return;
  }

  if (session?.state === "drem_custom") {
    try {
      const minutes = parseBeforeText(text);
      const cur = ((session.data?.reminders as number[]) || []);
      const reminders = [...new Set([...cur, minutes])].sort((a, b) => a - b);
      await showConfirm(db, chatId, user.telegram_id, user.timezone, {
        ...(session.data || {}),
        reminders,
      });
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "edit_title") {
    const title = text.replace(/\s+/g, " ").trim();
    if (!title) {
      await sendMessage(chatId, "Назва не може бути порожньою.");
      return;
    }
    try {
      const eventId = String(session.data?.eventId || "");
      const updated = await updateEvent(db, user, eventId, { summary: title });
      await sendMessage(chatId, "Назву оновлено ✓", {
        reply_markup: mainKeyboard(true),
      });
      await showExistingEdit(db, chatId, user, updated);
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (session?.state === "edit_desc") {
    try {
      const eventId = String(session.data?.eventId || "");
      const description = text === "-" ? "" : text.trim();
      const updated = await updateEvent(db, user, eventId, { description });
      await sendMessage(chatId, "Опис оновлено ✓", {
        reply_markup: mainKeyboard(true),
      });
      await showExistingEdit(db, chatId, user, updated);
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (session?.state === "edit_time") {
    try {
      const { hour, minute } = parseTimeText(text);
      const eventId = String(session.data?.eventId || "");
      const event = await getEvent(db, user, eventId);
      const parts = eventCivilParts(event, user.timezone);
      const start = toIsoLocal(parts.ymd, hour, minute, user.timezone);
      const endTotal = hour * 60 + minute + parts.durationMin;
      const endDayAdd = Math.floor(endTotal / (24 * 60));
      const endMins = endTotal % (24 * 60);
      const end = toIsoLocal(
        endDayAdd ? addDaysYmd(parts.ymd, endDayAdd) : parts.ymd,
        Math.floor(endMins / 60),
        endMins % 60,
        user.timezone,
      );
      const updated = await updateEvent(db, user, eventId, { start, end });
      await sendMessage(chatId, "Час оновлено ✓", {
        reply_markup: mainKeyboard(true),
      });
      await showExistingEdit(db, chatId, user, updated);
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "edit_date_custom") {
    try {
      const ymd = parseDateText(text, user.timezone);
      const eventId = String(session.data?.eventId || "");
      const event = await getEvent(db, user, eventId);
      const parts = eventCivilParts(event, user.timezone);
      const start = toIsoLocal(ymd, parts.hour, parts.minute, user.timezone);
      const endTotal = parts.hour * 60 + parts.minute + parts.durationMin;
      const endDayAdd = Math.floor(endTotal / (24 * 60));
      const endMins = endTotal % (24 * 60);
      const end = toIsoLocal(
        endDayAdd ? addDaysYmd(ymd, endDayAdd) : ymd,
        Math.floor(endMins / 60),
        endMins % 60,
        user.timezone,
      );
      const updated = await updateEvent(db, user, eventId, { start, end });
      await sendMessage(chatId, "Дату оновлено ✓", {
        reply_markup: mainKeyboard(true),
      });
      await showExistingEdit(db, chatId, user, updated);
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "erem_custom") {
    try {
      const minutes = parseBeforeText(text);
      const eventId = String(session.data?.eventId || "");
      await addEventReminder(db, user.telegram_id, eventId, minutes);
      const event = await getEvent(db, user, eventId);
      await sendMessage(chatId, `Додано нагадування за ${formatMinutes(minutes)}`);
      await showEventRemindersScreen(db, chatId, user, event);
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "rem_before_custom") {
    try {
      const minutes = parseBeforeText(text);
      await addBeforeReminder(db, user.telegram_id, minutes);
      await clearSession(db, user.telegram_id);
      const rules = await listReminderRules(db, user.telegram_id);
      await sendMessage(
        chatId,
        `Додано: за ${formatMinutes(minutes)} до події.\n\n` +
          await remindersText(db, user.telegram_id, user.timezone),
        { reply_markup: remindersKb(rules) },
      );
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "rem_abs_date") {
    try {
      const ymd = parseDateText(text, user.timezone);
      await setSession(db, user.telegram_id, "rem_abs_time", { ymd });
      await sendMessage(
        chatId,
        `Дата: <b>${formatYmd(ymd)}</b>\nТепер напиши час (наприклад <code>09:30</code> або <code>9 30</code>):`,
        { reply_markup: cancelKeyboard() },
      );
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "rem_abs_time") {
    try {
      const { hour, minute } = parseTimeText(text);
      await setSession(db, user.telegram_id, "rem_abs_title", {
        ...(session.data || {}),
        hour,
        minute,
      });
      await sendMessage(
        chatId,
        "Про що нагадати? Напиши короткий текст:",
        { reply_markup: cancelKeyboard() },
      );
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  if (session?.state === "rem_abs_title") {
    const ymd = session.data?.ymd as Ymd;
    const hour = Number(session.data?.hour);
    const minute = Number(session.data?.minute);
    const absoluteAt = toIsoLocal(ymd, hour, minute, user.timezone);
    const title = text.trim() || "Нагадування";
    await addAbsoluteReminder(db, user.telegram_id, absoluteAt, title);
    await clearSession(db, user.telegram_id);
    const rules = await listReminderRules(db, user.telegram_id);
    await sendMessage(
      chatId,
      `Додано точне нагадування ✓\n\n` +
        await remindersText(db, user.telegram_id, user.timezone),
      { reply_markup: remindersKb(rules) },
    );
    return;
  }
}

async function startConnect(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  telegramId: number,
) {
  const state = crypto.randomUUID().replace(/-/g, "");
  await db.from("oauth_states").upsert({
    state,
    telegram_id: telegramId,
    created_at: new Date().toISOString(),
  });
  await setSession(db, telegramId, "waiting_oauth");
  const url = buildAuthUrl(state);
  await sendMessage(
    chatId,
    "Натисни кнопку, увійди в Google і дозволь доступ до календаря.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔓 Відкрити Google", url }],
          [{ text: "❌ Скасувати", callback_data: "oauth:cancel" }],
        ],
      },
    },
  );
  void oauthRedirectUri;
}

async function resolveDateCallback(
  data: string,
  timezone: string,
): Promise<Ymd | "custom" | "noop" | null> {
  const ctx = nowParts(timezone);
  if (data === "cal:noop") return "noop";
  if (data === "cal:today" || data === "date:today") {
    return { y: ctx.y, m: ctx.m, d: ctx.d };
  }
  if (data === "cal:tomorrow" || data === "date:tomorrow") {
    return addDaysYmd(ctx, 1);
  }
  if (data === "cal:custom" || data === "date:custom") return "custom";
  const picked = parseCalPick(data);
  if (picked) return picked;
  return null;
}

async function handleCallback(
  db: ReturnType<typeof adminClient>,
  update: Update,
) {
  const cq = update.callback_query!;
  const data = cq.data || "";
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (!chatId) return;

  const user = await upsertUser(db, cq.from);
  const isConn = connected(user);

  if (data === "oauth:cancel") {
    await clearSession(db, user.telegram_id);
    await answerCallback(cq.id, "Скасовано");
    if (messageId) {
      await editMessageText(chatId, messageId, "Підключення скасовано.");
    }
    await sendMessage(chatId, "Меню:", { reply_markup: mainKeyboard(isConn) });
    return;
  }

  if (data === "connect") {
    await answerCallback(cq.id);
    await startConnect(db, chatId, user.telegram_id);
    return;
  }

  if (data === "settings:open") {
    await answerCallback(cq.id);
    if (messageId) {
      await editMessageText(chatId, messageId, await settingsText(db, user), {
        reply_markup: settingsKb(isConn),
      });
    }
    return;
  }

  if (data === "settings:timezone") {
    await answerCallback(cq.id);
    if (messageId) {
      await editMessageText(chatId, messageId, "Обери часовий пояс:", {
        reply_markup: timezoneKb(user.timezone),
      });
    }
    return;
  }

  if (data === "settings:disconnect") {
    await updateUser(db, user.telegram_id, {
      google_refresh_token: null,
      google_access_token: null,
      google_token_expiry: null,
    });
    const fresh = await getUser(db, user.telegram_id);
    await answerCallback(cq.id, "Відключено");
    if (messageId && fresh) {
      await editMessageText(chatId, messageId, await settingsText(db, fresh), {
        reply_markup: settingsKb(false),
      });
    }
    await sendMessage(chatId, "Календар відключено.", {
      reply_markup: mainKeyboard(false),
    });
    return;
  }

  if (data.startsWith("tz:")) {
    const zone = data.slice(3);
    const fresh = await updateUser(db, user.telegram_id, { timezone: zone });
    await answerCallback(cq.id, zone);
    if (messageId) {
      await editMessageText(chatId, messageId, await settingsText(db, fresh), {
        reply_markup: settingsKb(connected(fresh)),
      });
    }
    return;
  }

  // --- reminders settings ---
  if (data === "rem:open") {
    await answerCallback(cq.id);
    const rules = await listReminderRules(db, user.telegram_id);
    if (messageId) {
      await editMessageText(
        chatId,
        messageId,
        await remindersText(db, user.telegram_id, user.timezone),
        { reply_markup: remindersKb(rules) },
      );
    }
    return;
  }

  if (data === "rem:add_before") {
    await answerCallback(cq.id);
    if (messageId) {
      await editMessageText(
        chatId,
        messageId,
        "За скільки нагадувати <b>до події</b>?",
        { reply_markup: beforePresetsKb() },
      );
    }
    return;
  }

  if (data.startsWith("rem:before:")) {
    const minutes = Number(data.split(":")[2]);
    await addBeforeReminder(db, user.telegram_id, minutes);
    await answerCallback(cq.id, "Додано");
    const rules = await listReminderRules(db, user.telegram_id);
    if (messageId) {
      await editMessageText(
        chatId,
        messageId,
        await remindersText(db, user.telegram_id, user.timezone),
        { reply_markup: remindersKb(rules) },
      );
    }
    return;
  }

  if (data === "rem:before_custom") {
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "rem_before_custom");
    await sendMessage(
      chatId,
      "Напиши інтервал:\n<code>30</code>, <code>30 хв</code>, <code>2 год</code>, <code>1 день</code>",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  if (data === "rem:add_abs") {
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "rem_abs_date");
    await sendMessage(
      chatId,
      "<b>Точне нагадування</b>\nКрок 1 — дата.\nНапиши: <code>20.07</code> або <code>сьогодні</code>/<code>завтра</code>",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  if (data.startsWith("rem:del:")) {
    const id = Number(data.split(":")[2]);
    await deleteReminderRule(db, user.telegram_id, id);
    await answerCallback(cq.id, "Видалено");
    const rules = await listReminderRules(db, user.telegram_id);
    if (messageId) {
      await editMessageText(
        chatId,
        messageId,
        await remindersText(db, user.telegram_id, user.timezone),
        { reply_markup: remindersKb(rules) },
      );
    }
    return;
  }

  // --- month calendar navigation ---
  if (data.startsWith("cal:nav:")) {
    const nav = parseCalNav(data);
    await answerCallback(cq.id);
    if (nav && messageId) {
      await editMessageText(
        chatId,
        messageId,
        "Обери день у календарі 👇\n<i>•день• — сьогодні</i>",
        { reply_markup: monthCalendarKeyboard(nav.y, nav.m, user.timezone) },
      );
    }
    return;
  }

  // --- create / edit date picker (calendar) ---
  if (data.startsWith("cal:") || data.startsWith("date:")) {
    const session = await getSession(db, user.telegram_id);
    const resolved = await resolveDateCallback(data, user.timezone);
    if (resolved === "noop") {
      await answerCallback(cq.id);
      return;
    }
    await answerCallback(cq.id);
    if (resolved === "custom") {
      const returnTo = session?.state === "edit_event" ||
          session?.data?.returnTo === "edit_event" ||
          session?.data?.pickingDateFor === "edit"
        ? "edit_event"
        : session?.state === "create_confirm" ||
            session?.data?.returnTo === "create_confirm"
        ? "create_confirm"
        : undefined;
      if (returnTo === "edit_event") {
        await setSession(db, user.telegram_id, "edit_date_custom", {
          ...(session?.data || {}),
        });
      } else {
        await setSession(db, user.telegram_id, "create_date_custom", {
          ...(session?.data || {}),
          returnTo,
        });
      }
      await sendMessage(
        chatId,
        "Напиши дату:\n<code>20.07</code> або <code>20.07.2026</code>",
        { reply_markup: cancelKeyboard() },
      );
      return;
    }
    if (resolved) {
      if (session?.state === "edit_event" || session?.data?.pickingDateFor === "edit") {
        try {
          const eventId = String(session?.data?.eventId || "");
          const event = await getEvent(db, user, eventId);
          const parts = eventCivilParts(event, user.timezone);
          const start = toIsoLocal(
            resolved,
            parts.hour,
            parts.minute,
            user.timezone,
          );
          const endTotal = parts.hour * 60 + parts.minute + parts.durationMin;
          const endDayAdd = Math.floor(endTotal / (24 * 60));
          const endMins = endTotal % (24 * 60);
          const end = toIsoLocal(
            endDayAdd ? addDaysYmd(resolved, endDayAdd) : resolved,
            Math.floor(endMins / 60),
            endMins % 60,
            user.timezone,
          );
          const updated = await updateEvent(db, user, eventId, { start, end });
          await showExistingEdit(db, chatId, user, updated, {
            editMessageId: messageId,
          });
        } catch (e) {
          await sendMessage(chatId, `Помилка: ${e}`);
        }
        return;
      }
      if (
        session?.state === "create_confirm" ||
        session?.data?.returnTo === "create_confirm"
      ) {
        await showConfirm(db, chatId, user.telegram_id, user.timezone, {
          ...(session?.data || {}),
          ymd: resolved,
        }, { editMessageId: messageId });
        return;
      }
      if (messageId) {
        await editMessageText(
          chatId,
          messageId,
          `Дата: <b>${formatYmd(resolved)}</b> ✓`,
        );
      }
      await askTime(db, chatId, user.telegram_id, resolved);
    }
    return;
  }

  if (data === "event:cancel") {
    await clearSession(db, user.telegram_id);
    await answerCallback(cq.id, "Скасовано");
    if (messageId) await editMessageText(chatId, messageId, "Скасовано.");
    await sendMessage(chatId, "Меню:", { reply_markup: mainKeyboard(isConn) });
    return;
  }

  if (data === "event:restart") {
    await answerCallback(cq.id);
    if (messageId) await editMessageText(chatId, messageId, "Починаємо знову…");
    await startCreateFlow(db, chatId, user.telegram_id, user.timezone);
    return;
  }

  // --- draft edit (before create) ---
  if (data === "cedit:back") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await showConfirm(
      db,
      chatId,
      user.telegram_id,
      user.timezone,
      session?.data || {},
      { editMessageId: messageId },
    );
    return;
  }

  if (data === "cedit:title") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "create_edit_title", session?.data || {});
    await sendMessage(chatId, "Нова назва події:", {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  if (data === "cedit:time") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "create_time", {
      ...(session?.data || {}),
      returnTo: "create_confirm",
    });
    await sendMessage(
      chatId,
      "Новий час (`15`, `15:00`, `8 30`):",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  if (data === "cedit:date") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "create_confirm", {
      ...(session?.data || {}),
      returnTo: "create_confirm",
    });
    if (messageId) {
      await editMessageText(chatId, messageId, "Обери день у календарі 👇", {
        reply_markup: dateKeyboard(user.timezone),
      });
    }
    return;
  }

  if (data === "cedit:desc") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "create_edit_desc", session?.data || {});
    await sendMessage(
      chatId,
      "Напиши опис події.\nЩоб очистити опис — надішли <code>-</code>",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  if (data === "cedit:rem") {
    const session = await getSession(db, user.telegram_id);
    const reminders = (session?.data?.reminders as number[]) || [];
    await answerCallback(cq.id);
    const text =
      `<b>Нагадування для цієї події</b>\n` +
      (reminders.length
        ? reminders.map((m, i) => `${i + 1}. за ${formatMinutes(m)}`).join("\n")
        : "Зараз: <i>загальні налаштування</i>");
    if (messageId) {
      await editMessageText(chatId, messageId, text, {
        reply_markup: draftRemindersKb(reminders),
      });
    }
    return;
  }

  if (data === "drem:add") {
    await answerCallback(cq.id);
    if (messageId) {
      await editMessageText(chatId, messageId, "За скільки нагадати?", {
        reply_markup: remAddPresetsKb("drem"),
      });
    }
    return;
  }

  if (data.startsWith("drem:set:")) {
    const minutes = Number(data.split(":")[2]);
    const session = await getSession(db, user.telegram_id);
    const cur = ((session?.data?.reminders as number[]) || []);
    const reminders = [...new Set([...cur, minutes])].sort((a, b) => a - b);
    await answerCallback(cq.id, "Додано");
    await setSession(db, user.telegram_id, "create_confirm", {
      ...(session?.data || {}),
      reminders,
      draft: buildDraftFromData({ ...(session?.data || {}), reminders }, user.timezone),
    });
    const text =
      `<b>Нагадування для цієї події</b>\n` +
      reminders.map((m, i) => `${i + 1}. за ${formatMinutes(m)}`).join("\n");
    if (messageId) {
      await editMessageText(chatId, messageId, text, {
        reply_markup: draftRemindersKb(reminders),
      });
    }
    return;
  }

  if (data.startsWith("drem:del:")) {
    const minutes = Number(data.split(":")[2]);
    const session = await getSession(db, user.telegram_id);
    const reminders = ((session?.data?.reminders as number[]) || [])
      .filter((m) => m !== minutes);
    await answerCallback(cq.id, "Видалено");
    await setSession(db, user.telegram_id, "create_confirm", {
      ...(session?.data || {}),
      reminders,
      draft: buildDraftFromData({ ...(session?.data || {}), reminders }, user.timezone),
    });
    const text =
      `<b>Нагадування для цієї події</b>\n` +
      (reminders.length
        ? reminders.map((m, i) => `${i + 1}. за ${formatMinutes(m)}`).join("\n")
        : "Зараз: <i>загальні налаштування</i>");
    if (messageId) {
      await editMessageText(chatId, messageId, text, {
        reply_markup: draftRemindersKb(reminders),
      });
    }
    return;
  }

  if (data === "drem:custom") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "drem_custom", session?.data || {});
    await sendMessage(
      chatId,
      "Інтервал: <code>30</code>, <code>2 год</code>, <code>1 день</code>",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  if (data === "event:confirm") {
    const session = await getSession(db, user.telegram_id);
    const dataObj = session?.data || {};
    const draft = buildDraftFromData(dataObj, user.timezone);
    try {
      const created = await createEvent(db, user, draft);
      const reminders = (dataObj.reminders as number[]) || [];
      if (reminders.length) {
        await setEventReminders(db, user.telegram_id, created.id, reminders);
      }
      await clearSession(db, user.telegram_id);
      await answerCallback(cq.id, "Готово");
      const link = created.htmlLink
        ? `\n<a href="${created.htmlLink}">Відкрити в Google Calendar</a>`
        : "";
      if (messageId) {
        await editMessageText(
          chatId,
          messageId,
          `Створено ✓\n\n📌 <b>${escapeHtml(created.summary)}</b>\n🕒 ${
            formatWhen(created, user.timezone)
          }${link}`,
        );
      }
      const remLine = reminders.length
        ? `Нагадування: ${reminders.map((m) => `за ${formatMinutes(m)}`).join(", ")}.`
        : "Нагадування: як у загальних налаштуваннях.";
      await sendMessage(chatId, remLine, {
        reply_markup: mainKeyboard(true),
      });
    } catch (e) {
      await answerCallback(cq.id, "Помилка");
      await sendMessage(chatId, `Не вдалося створити подію: ${e}`);
    }
    return;
  }

  // --- existing event edit ---
  if (data === "evlist") {
    await answerCallback(cq.id);
    try {
      const session = await getSession(db, user.telegram_id);
      const mode = (session?.data?.mode as "view" | "edit") || "edit";
      const page = Number(session?.data?.page || 0);
      await sendEventsList(db, chatId, user, {
        editMessageId: messageId,
        mode,
        page,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data.startsWith("evpage:")) {
    const page = Number(data.split(":")[1] || 0);
    await answerCallback(cq.id);
    try {
      const session = await getSession(db, user.telegram_id);
      const mode = (session?.data?.mode as "view" | "edit") || "edit";
      await sendEventsList(db, chatId, user, {
        editMessageId: messageId,
        mode,
        page,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data.startsWith("evopen:")) {
    const idx = Number(data.split(":")[1]);
    const session = await getSession(db, user.telegram_id);
    const listIds = (session?.data?.listIds as string[]) || [];
    const eventId = listIds[idx];
    await answerCallback(cq.id);
    if (!eventId) {
      await sendMessage(chatId, "Подію не знайдено, відкрий список знову.");
      return;
    }
    try {
      const event = await getEvent(db, user, eventId);
      await showExistingEdit(db, chatId, user, event, {
        editMessageId: messageId,
        listIds,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data === "eedit:back") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    try {
      const event = await getEvent(db, user, String(session?.data?.eventId));
      await showExistingEdit(db, chatId, user, event, {
        editMessageId: messageId,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data === "eedit:title") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "edit_title", session?.data || {});
    await sendMessage(chatId, "Нова назва:", { reply_markup: cancelKeyboard() });
    return;
  }

  if (data === "eedit:time") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "edit_time", session?.data || {});
    await sendMessage(
      chatId,
      "Новий час (`15`, `15:00`, `8 30`):",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  if (data === "eedit:date") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "edit_event", {
      ...(session?.data || {}),
      pickingDateFor: "edit",
    });
    if (messageId) {
      await editMessageText(chatId, messageId, "Обери день у календарі 👇", {
        reply_markup: dateKeyboard(user.timezone),
      });
    }
    return;
  }

  if (data === "eedit:desc") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "edit_desc", session?.data || {});
    await sendMessage(
      chatId,
      "Новий опис (або <code>-</code> щоб очистити):",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  if (data === "eedit:rem") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    try {
      const event = await getEvent(db, user, String(session?.data?.eventId));
      await showEventRemindersScreen(db, chatId, user, event, {
        editMessageId: messageId,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data === "erem:add") {
    await answerCallback(cq.id);
    if (messageId) {
      await editMessageText(chatId, messageId, "За скільки нагадати?", {
        reply_markup: remAddPresetsKb("erem"),
      });
    }
    return;
  }

  if (data.startsWith("erem:set:")) {
    const minutes = Number(data.split(":")[2]);
    const session = await getSession(db, user.telegram_id);
    const eventId = String(session?.data?.eventId || "");
    await addEventReminder(db, user.telegram_id, eventId, minutes);
    await answerCallback(cq.id, "Додано");
    try {
      const event = await getEvent(db, user, eventId);
      await showEventRemindersScreen(db, chatId, user, event, {
        editMessageId: messageId,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data.startsWith("erem:del:")) {
    const minutes = Number(data.split(":")[2]);
    const session = await getSession(db, user.telegram_id);
    const eventId = String(session?.data?.eventId || "");
    await removeEventReminder(db, user.telegram_id, eventId, minutes);
    await answerCallback(cq.id, "Видалено");
    try {
      const event = await getEvent(db, user, eventId);
      await showEventRemindersScreen(db, chatId, user, event, {
        editMessageId: messageId,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data === "erem:reset") {
    const session = await getSession(db, user.telegram_id);
    const eventId = String(session?.data?.eventId || "");
    await setEventReminders(db, user.telegram_id, eventId, []);
    await answerCallback(cq.id, "Скинуто");
    try {
      const event = await getEvent(db, user, eventId);
      await showEventRemindersScreen(db, chatId, user, event, {
        editMessageId: messageId,
      });
    } catch (e) {
      await sendMessage(chatId, `Помилка: ${e}`);
    }
    return;
  }

  if (data === "erem:custom") {
    const session = await getSession(db, user.telegram_id);
    await answerCallback(cq.id);
    await setSession(db, user.telegram_id, "erem_custom", session?.data || {});
    await sendMessage(
      chatId,
      "Інтервал: <code>30</code>, <code>2 год</code>, <code>1 день</code>",
      { reply_markup: cancelKeyboard() },
    );
  }
}
