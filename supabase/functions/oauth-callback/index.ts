import { adminClient, clearSession, getEnv, getUser, updateUser } from "../_shared/db.ts";
import { exchangeCode } from "../_shared/google.ts";
import { mainKeyboard, sendMessage } from "../_shared/telegram.ts";

function botUrl(start?: string): string {
  const username = getEnv("TELEGRAM_BOT_USERNAME", "eventping_bot").replace(
    /^@/,
    "",
  );
  const base = `https://t.me/${username}`;
  return start ? `${base}?start=${encodeURIComponent(start)}` : base;
}

function redirectToBot(start?: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: botUrl(start),
      "Cache-Control": "no-store",
    },
  });
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    if (error) {
      return redirectToBot("oauth_cancel");
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return redirectToBot("oauth_error");
    }

    const db = adminClient();
    const { data: row, error: stErr } = await db
      .from("oauth_states")
      .select("*")
      .eq("state", state)
      .maybeSingle();
    if (stErr) throw stErr;
    if (!row) {
      return redirectToBot("oauth_expired");
    }

    const tokens = await exchangeCode(code);
    const existing = await getUser(db, row.telegram_id);
    const refresh = tokens.refresh_token || existing?.google_refresh_token;
    if (!refresh) {
      await sendMessage(
        row.telegram_id,
        "Не вдалося підключити календар: Google не повернув refresh token.\n" +
          "Відклич доступ EventPing у https://myaccount.google.com/permissions і спробуй знову.",
        { reply_markup: mainKeyboard(false) },
      );
      return redirectToBot("oauth_token");
    }

    const expiry = new Date(Date.now() + (tokens.expires_in || 3600) * 1000)
      .toISOString();
    await updateUser(db, row.telegram_id, {
      google_refresh_token: refresh,
      google_access_token: tokens.access_token,
      google_token_expiry: expiry,
    });
    await db.from("oauth_states").delete().eq("state", state);
    await clearSession(db, row.telegram_id);

    await sendMessage(
      row.telegram_id,
      "Готово! Google Calendar підключено ✓\nТепер можу показувати події, створювати записи і нагадувати.",
      { reply_markup: mainKeyboard(true) },
    );

    return redirectToBot();
  } catch (err) {
    console.error(err);
    return redirectToBot("oauth_error");
  }
});
