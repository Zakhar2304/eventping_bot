import { getEnv } from "./db.ts";

const API = () => `https://api.telegram.org/bot${getEnv("BOT_TOKEN")}`;

export type TgUser = {
  id: number;
  username?: string;
  first_name?: string;
};

export type Update = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number };
    from?: TgUser;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: TgUser;
    data?: string;
    message?: {
      message_id: number;
      chat: { id: number };
      text?: string;
    };
  };
};

async function call(method: string, body: Record<string, unknown>) {
  const res = await fetch(`${API()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error("Telegram API error", method, json);
  }
  return json;
}

export function mainKeyboard(connected: boolean) {
  return {
    keyboard: [
      // зверху
      [{ text: "➕ Нова подія" }, { text: "✏️ Редагувати подію" }],
      // посередині
      [{ text: "📅 Найближчі" }, { text: "⏰ Нагадування" }],
      // знизу в два ряди
      [
        { text: connected ? "🔗 Календар ✓" : "🔗 Підключити календар" },
        { text: "ℹ️ Допомога" },
      ],
      [{ text: "⚙️ Налаштування" }],
    ],
    resize_keyboard: true,
  };
}

export function cancelKeyboard() {
  return {
    keyboard: [[{ text: "❌ Скасувати" }]],
    resize_keyboard: true,
  };
}

export async function sendMessage(
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return await call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return await call("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    ...extra,
  });
}

export async function answerCallback(callbackId: string, text?: string) {
  return await call("answerCallbackQuery", {
    callback_query_id: callbackId,
    text,
  });
}

export async function setWebhook(url: string) {
  return await call("setWebhook", {
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  });
}
