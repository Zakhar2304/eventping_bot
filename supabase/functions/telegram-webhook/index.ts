import {
  adminClient,
  clearSession,
  getSession,
  getUser,
  setSession,
  updateUser,
  upsertUser,
} from "../_shared/db.ts";
import {
  buildAuthUrl,
  createEvent,
  formatWhen,
  listUpcoming,
  oauthRedirectUri,
} from "../_shared/google.ts";
import { parseEventText } from "../_shared/parser.ts";
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
  `<b>Швидке створення:</b>\n` +
  `<code>Завтра 15:00 Зустріч з клієнтом</code>\n` +
  `<code>21.07 18:30 Вечеря @Кафе</code>\n` +
  `<code>Через 2 години Дзвінок</code>`;

function settingsText(u: {
  google_refresh_token: string | null;
  reminder_minutes: number;
  timezone: string;
}) {
  const cal = u.google_refresh_token ? "підключено ✓" : "не підключено";
  return (
    `<b>Налаштування</b>\n\n🔗 Календар: ${cal}\n` +
    `⏰ Нагадування: за ${u.reminder_minutes} хв\n` +
    `🌍 Часовий пояс: ${u.timezone}`
  );
}

function settingsKb(connected: boolean, minutes: number, tz: string) {
  return {
    inline_keyboard: [
      [{ text: `⏰ Нагадувати за ${minutes} хв`, callback_data: "settings:reminder" }],
      [{ text: `🌍 ${tz}`, callback_data: "settings:timezone" }],
      connected
        ? [{ text: "🔌 Відключити календар", callback_data: "settings:disconnect" }]
        : [{ text: "🔗 Підключити календар", callback_data: "connect" }],
    ],
  };
}

function reminderKb(current: number) {
  const presets = [
    [5, "5 хв"],
    [10, "10 хв"],
    [15, "15 хв"],
    [30, "30 хв"],
    [60, "1 год"],
    [120, "2 год"],
    [1440, "1 день"],
  ] as const;
  const row1 = presets.slice(0, 3).map(([m, l]) => ({
    text: `${m === current ? "✓ " : ""}${l}`,
    callback_data: `reminder:${m}`,
  }));
  const row2 = presets.slice(3, 6).map(([m, l]) => ({
    text: `${m === current ? "✓ " : ""}${l}`,
    callback_data: `reminder:${m}`,
  }));
  const row3 = presets.slice(6).map(([m, l]) => ({
    text: `${m === current ? "✓ " : ""}${l}`,
    callback_data: `reminder:${m}`,
  }));
  return { inline_keyboard: [row1, row2, row3] };
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
    inline_keyboard: zones.map((z) => [{
      text: `${z === current ? "✓ " : ""}${z}`,
      callback_data: `tz:${z}`,
    }]),
  };
}

function confirmKb() {
  return {
    inline_keyboard: [
      [
        { text: "✅ Створити", callback_data: "event:confirm" },
        { text: "✏️ Змінити", callback_data: "event:edit" },
      ],
      [{ text: "❌ Скасувати", callback_data: "event:cancel" }],
    ],
  };
}

function connected(u: { google_refresh_token: string | null }) {
  return !!u.google_refresh_token;
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

async function handleMessage(db: ReturnType<typeof adminClient>, update: Update) {
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
      `Привіт, ${name}! Я <b>EventPing</b> 👋\n\n${status}\n\nНагадуватиму за <b>${user.reminder_minutes} хв</b>.`,
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
      const lines = [
        `<b>Найближчі події</b> (нагадування за ${user.reminder_minutes} хв):\n`,
      ];
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
    await sendMessage(chatId, settingsText(user), {
      reply_markup: settingsKb(isConn, user.reminder_minutes, user.timezone),
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
    await setSession(db, user.telegram_id, "waiting_event");
    await sendMessage(
      chatId,
      "Напиши подію одним рядком.\n\nПриклади:\n• <code>Завтра 15:00 Зустріч</code>\n• <code>Через 2 години Дзвінок</code>",
      { reply_markup: cancelKeyboard() },
    );
    return;
  }

  // Paste OAuth code while connecting
  if (session?.state === "waiting_oauth") {
    await sendMessage(
      chatId,
      "Відкрий кнопку Google вище. Якщо редірект не відкрився — зачекай підтвердження, або спробуй ще раз /connect.",
    );
    return;
  }

  if (session?.state === "waiting_event" || session?.state === "confirm_event") {
    if (!isConn) {
      await clearSession(db, user.telegram_id);
      await sendMessage(chatId, "Спочатку підключи календар.");
      return;
    }
    try {
      const draft = parseEventText(text, user.timezone);
      await setSession(db, user.telegram_id, "confirm_event", { draft });
      const loc = draft.location ? `\n📍 ${draft.location}` : "";
      await sendMessage(
        chatId,
        `<b>Перевір подію</b>\n\n📌 ${escapeHtml(draft.summary)}\n🕒 ${
          draft.start
        }${loc}\n\nСтворити в Google Calendar?`,
        { reply_markup: confirmKb() },
      );
    } catch (e) {
      await sendMessage(chatId, String(e));
    }
    return;
  }

  // Smart create from free text
  if (
    isConn &&
    /^(завтра|сьогодні|післязавтра|через|в\s|у\s|\d{1,2}[.:]|\d{1,2}\.\d{1,2})/i
      .test(text)
  ) {
    try {
      const draft = parseEventText(text, user.timezone);
      await setSession(db, user.telegram_id, "confirm_event", { draft });
      const loc = draft.location ? `\n📍 ${draft.location}` : "";
      await sendMessage(
        chatId,
        `<b>Перевір подію</b>\n\n📌 ${escapeHtml(draft.summary)}\n🕒 ${
          draft.start
        }${loc}\n\nСтворити в Google Calendar?`,
        { reply_markup: confirmKb() },
      );
    } catch {
      // ignore non-event messages
    }
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
    `Натисни кнопку, увійди в Google і дозволь доступ до календаря.\n\n` +
      `Redirect: <code>${oauthRedirectUri()}</code>`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔓 Відкрити Google", url }],
          [{ text: "❌ Скасувати", callback_data: "oauth:cancel" }],
        ],
      },
    },
  );
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

  if (data === "settings:reminder") {
    await answerCallback(cq.id);
    if (messageId) {
      await editMessageText(chatId, messageId, "За скільки нагадувати?", {
        reply_markup: reminderKb(user.reminder_minutes),
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
      await editMessageText(chatId, messageId, settingsText(fresh), {
        reply_markup: settingsKb(false, fresh.reminder_minutes, fresh.timezone),
      });
    }
    await sendMessage(chatId, "Календар відключено.", {
      reply_markup: mainKeyboard(false),
    });
    return;
  }

  if (data.startsWith("reminder:")) {
    const minutes = Number(data.split(":")[1]);
    const fresh = await updateUser(db, user.telegram_id, {
      reminder_minutes: minutes,
    });
    await answerCallback(cq.id, `За ${minutes} хв`);
    if (messageId) {
      await editMessageText(chatId, messageId, settingsText(fresh), {
        reply_markup: settingsKb(
          connected(fresh),
          fresh.reminder_minutes,
          fresh.timezone,
        ),
      });
    }
    return;
  }

  if (data.startsWith("tz:")) {
    const zone = data.slice(3);
    const fresh = await updateUser(db, user.telegram_id, { timezone: zone });
    await answerCallback(cq.id, zone);
    if (messageId) {
      await editMessageText(chatId, messageId, settingsText(fresh), {
        reply_markup: settingsKb(
          connected(fresh),
          fresh.reminder_minutes,
          fresh.timezone,
        ),
      });
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

  if (data === "event:edit") {
    await setSession(db, user.telegram_id, "waiting_event");
    await answerCallback(cq.id);
    if (messageId) {
      await editMessageText(chatId, messageId, "Ок, надішли новий текст події.");
    }
    await sendMessage(chatId, "Чекаю на текст:", {
      reply_markup: cancelKeyboard(),
    });
    return;
  }

  if (data === "event:confirm") {
    const session = await getSession(db, user.telegram_id);
    const draft = session?.data?.draft as {
      summary: string;
      start: string;
      end: string;
      location?: string;
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
      await sendMessage(
        chatId,
        `Нагадаю за ${user.reminder_minutes} хв до початку.`,
        { reply_markup: mainKeyboard(true) },
      );
    } catch (e) {
      await answerCallback(cq.id, "Помилка");
      await sendMessage(chatId, `Не вдалося створити подію: ${e}`);
    }
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
