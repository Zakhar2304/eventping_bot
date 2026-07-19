import { adminClient, getEnv, listConnectedUsers } from "../_shared/db.ts";
import { eventsNeedingReminder, formatWhen } from "../_shared/google.ts";
import { sendMessage } from "../_shared/telegram.ts";

function authorized(req: Request): boolean {
  const secret = getEnv("CRON_SECRET");
  if (!secret) return true; // allow if not set (first setup)
  const header = req.headers.get("x-cron-secret") || "";
  const auth = req.headers.get("authorization") || "";
  return header === secret || auth === `Bearer ${secret}`;
}

Deno.serve(async (req) => {
  if (!authorized(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const db = adminClient();
  const users = await listConnectedUsers(db);
  let sent = 0;
  const errors: string[] = [];

  for (const user of users) {
    try {
      const due = await eventsNeedingReminder(db, user, 1);
      for (const { event, remindAt } of due) {
        const { data: existing } = await db
          .from("sent_reminders")
          .select("id")
          .eq("telegram_id", user.telegram_id)
          .eq("event_id", event.id)
          .eq("remind_at", remindAt.toISOString())
          .maybeSingle();
        if (existing) continue;

        const loc = event.location ? `\n📍 ${escapeHtml(event.location)}` : "";
        const link = event.htmlLink
          ? `\n<a href="${event.htmlLink}">Відкрити</a>`
          : "";
        await sendMessage(
          user.telegram_id,
          `⏰ <b>Нагадування</b> (за ${user.reminder_minutes} хв)\n\n` +
            `📌 <b>${escapeHtml(event.summary)}</b>\n` +
            `🕒 ${escapeHtml(formatWhen(event, user.timezone))}${loc}${link}`,
        );
        await db.from("sent_reminders").upsert({
          telegram_id: user.telegram_id,
          event_id: event.id,
          remind_at: remindAt.toISOString(),
          created_at: new Date().toISOString(),
        }, { onConflict: "telegram_id,event_id,remind_at" });
        sent += 1;
      }
    } catch (e) {
      console.error("reminders user failed", user.telegram_id, e);
      errors.push(`${user.telegram_id}: ${e}`);
    }
  }

  // cleanup oauth states
  try {
    await db.rpc("cleanup_oauth_states");
  } catch {
    // function may not exist yet
  }

  return new Response(JSON.stringify({ ok: true, users: users.length, sent, errors }), {
    headers: { "Content-Type": "application/json" },
  });
});

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
