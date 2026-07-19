import { adminClient, clearSession, getUser, updateUser } from "../_shared/db.ts";
import { exchangeCode } from "../_shared/google.ts";
import { mainKeyboard, sendMessage } from "../_shared/telegram.ts";

const OK_HTML = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"/><title>EventPing</title>
<style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#1e293b;padding:2rem;border-radius:16px;text-align:center;max-width:420px}
h1{margin:0 0 .5rem;font-size:1.4rem}p{margin:0;color:#94a3b8;line-height:1.5}
</style></head><body><div class="card">
<h1>Календар підключено</h1>
<p>Можна закрити вкладку і повернутися в Telegram до EventPing.</p>
</div></body></html>`;

function html(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const error = url.searchParams.get("error");
    if (error) {
      return html("Авторизацію скасовано. Поверніться в Telegram.", 400);
    }

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return html("Немає code/state. Запустіть підключення знову в боті.", 400);
    }

    const db = adminClient();
    const { data: row, error: stErr } = await db
      .from("oauth_states")
      .select("*")
      .eq("state", state)
      .maybeSingle();
    if (stErr) throw stErr;
    if (!row) {
      return html("Прострочений або невірний state. Спробуйте /connect знову.", 400);
    }

    const tokens = await exchangeCode(code);
    const existing = await getUser(db, row.telegram_id);
    const refresh = tokens.refresh_token || existing?.google_refresh_token;
    if (!refresh) {
      return html(
        "Google не повернув refresh token. Відклич доступ у myaccount.google.com/permissions і спробуй знову.",
        400,
      );
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

    return html(OK_HTML);
  } catch (err) {
    console.error(err);
    return html(`Помилка авторизації: ${err}`, 500);
  }
});
