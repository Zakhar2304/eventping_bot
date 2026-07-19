import {
  addAbsoluteReminder,
  addBeforeReminder,
  adminClient,
  clearSession,
  deleteReminderRule,
  getSession,
  getUser,
  listReminderRules,
  setSession,
  updateUser,
  upsertUser,
  type ReminderRule,
} from "../_shared/db.ts";
import {
  addDaysYmd,
  formatMinutes,
  formatYmd,
  nextWeekday,
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
  formatWhen,
  listUpcoming,
  oauthRedirectUri,
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
  `<b>Нова подія:</b> крок за кроком — дата → час → назва.\n` +
  `Час можна писати так: <code>15</code>, <code>15:00</code>, <code>15 00</code>, <code>8:30</code>, <code>8 30</code>.\n\n` +
  `У ⚙️ Налаштування можна додати <b>кілька нагадувань</b>: за скільки до події або на точну дату/час.`;

function connected(u: { google_refresh_token: string | null }) {
  return !!u.google_refresh_token;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function dateKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Сьогодні", callback_data: "date:today" },
        { text: "Завтра", callback_data: "date:tomorrow" },
      ],
      [{ text: "Післязавтра", callback_data: "date:after" }],
      [
        { text: "Пн", callback_data: "date:wd:1" },
        { text: "Вт", callback_data: "date:wd:2" },
        { text: "Ср", callback_data: "date:wd:3" },
        { text: "Чт", callback_data: "date:wd:4" },
      ],
      [
        { text: "Пт", callback_data: "date:wd:5" },
        { text: "Сб", callback_data: "date:wd:6" },
        { text: "Нд", callback_data: "date:wd:0" },
      ],
      [{ text: "📅 Інша дата…", callback_data: "date:custom" }],
      [{ text: "❌ Скасувати", callback_data: "event:cancel" }],
    ],
  };
}

function confirmKb() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Створити", callback_data: "event:confirm" },
        { text: "🔄 Спочатку", callback_data: "event:restart" },
      ],
      [{ text: "❌ Скасувати", callback_data: "event:cancel" }],
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
) {
  await setSession(db, telegramId, "create_date", {});
  await sendMessage(
    chatId,
    "<b>Нова подія</b>\nКрок 1/3 — обери дату:",
    { reply_markup: dateKeyboard() },
  );
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

async function showConfirm(
  db: ReturnType<typeof adminClient>,
  chatId: number,
  telegramId: number,
  timezone: string,
  data: Record<string, unknown>,
) {
  const ymd = data.ymd as Ymd;
  const hour = Number(data.hour);
  const minute = Number(data.minute);
  const title = String(data.title || "Подія");
  const start = toIsoLocal(ymd, hour, minute, timezone);
  const endHour = hour + 1;
  const endIso = endHour < 24
    ? toIsoLocal(ymd, endHour, minute, timezone)
    : toIsoLocal(addDaysYmd(ymd, 1), endHour - 24, minute, timezone);

  const draft = { summary: title, start, end: endIso };
  await setSession(db, telegramId, "create_confirm", { ...data, draft });
  await sendMessage(
    chatId,
    `<b>Перевір подію</b>\n\n` +
      `📌 ${escapeHtml(title)}\n` +
      `📅 ${formatYmd(ymd)}\n` +
      `🕒 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}\n\n` +
      `Створити в Google Calendar?`,
    { reply_markup: confirmKb() },
  );
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
      const events = await listUpcoming(db, user);
      if (!events.length) {
        await sendMessage(
          chatId,
          "На найближчі 7 днів подій немає.\nСтвори нову кнопкою ➕ Нова подія.",
          { reply_markup: mainKeyboard(true) },
        );
        return;
      }
      const lines = ["<b>Найближчі події</b>\n"];
      events.forEach((e, i) => {
        const loc = e.location ? `\n   📍 ${e.location}` : "";
        lines.push(
          `${i + 1}. <b>${escapeHtml(e.summary)}</b>\n   🕒 ${
            formatWhen(e, user.timezone)
          }${loc}`,
        );
      });
      await sendMessage(chatId, lines.join("\n\n"), {
        reply_markup: mainKeyboard(true),
      });
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
    await startCreateFlow(db, chatId, user.telegram_id);
    return;
  }

  // --- wizard text states ---
  if (session?.state === "create_date_custom") {
    try {
      const ymd = parseDateText(text, user.timezone);
      await askTime(db, chatId, user.telegram_id, ymd, session.data || {});
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
      await askTitle(db, chatId, user.telegram_id, {
        ...(session.data || {}),
        hour,
        minute,
        time,
      });
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
): Promise<Ymd | "custom" | null> {
  const ctx = nowParts(timezone);
  if (data === "date:today") return { y: ctx.y, m: ctx.m, d: ctx.d };
  if (data === "date:tomorrow") return addDaysYmd(ctx, 1);
  if (data === "date:after") return addDaysYmd(ctx, 2);
  if (data === "date:custom") return "custom";
  if (data.startsWith("date:wd:")) {
    const wd = Number(data.split(":")[2]);
    return nextWeekday(timezone, wd);
  }
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

  // --- create event date ---
  if (data.startsWith("date:")) {
    const resolved = await resolveDateCallback(data, user.timezone);
    await answerCallback(cq.id);
    if (resolved === "custom") {
      await setSession(db, user.telegram_id, "create_date_custom", {});
      await sendMessage(
        chatId,
        "Напиши дату:\n<code>20.07</code> або <code>20.07.2026</code>",
        { reply_markup: cancelKeyboard() },
      );
      return;
    }
    if (resolved) {
      if (messageId) {
        await editMessageText(
          chatId,
          messageId,
          `Дата: <b>${formatYmd(resolved)}</b>`,
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
    await startCreateFlow(db, chatId, user.telegram_id);
    return;
  }

  if (data === "event:confirm") {
    const session = await getSession(db, user.telegram_id);
    const draft = session?.data?.draft as {
      summary: string;
      start: string;
      end: string;
    } | undefined;
    if (!draft) {
      await answerCallback(cq.id, "Немає даних");
      return;
    }
    try {
      const created = await createEvent(db, user, draft);
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
      const rules = await listReminderRules(db, user.telegram_id);
      const before = rules.filter((r) => r.kind === "before");
      const remLine = before.length
        ? `Нагадування: ${
          before.map((r) => `за ${formatMinutes(r.minutes_before || 0)}`).join(", ")
        }.`
        : "Нагадувань «до події» немає — додай у ⏰ Нагадування.";
      await sendMessage(chatId, remLine, {
        reply_markup: mainKeyboard(true),
      });
    } catch (e) {
      await answerCallback(cq.id, "Помилка");
      await sendMessage(chatId, `Не вдалося створити подію: ${e}`);
    }
  }
}
