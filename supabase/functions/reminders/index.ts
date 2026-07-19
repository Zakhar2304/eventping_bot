import {
  adminClient,
  getEnv,
  listAllEventReminderMap,
  listConnectedUsers,
  listReminderRules,
} from "../_shared/db.ts";
import { formatMinutes } from "../_shared/datetime.ts";
import { eventsNeedingReminder, formatWhen } from "../_shared/google.ts";
import { sendMessage } from "../_shared/telegram.ts";

function authorized(req: Request): boolean {
  const secret = getEnv("CRON_SECRET");
  if (!secret) return true;
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

  // Absolute one-shot reminders (any user with rules)
  try {
    const now = new Date();
    const windowMs = 60_000;
    const { data: absRules, error } = await db
      .from("reminder_rules")
      .select("*")
      .eq("kind", "absolute")
      .gte("absolute_at", new Date(now.getTime() - windowMs).toISOString())
      .lte("absolute_at", new Date(now.getTime() + windowMs).toISOString());
    if (error) throw error;

    for (const rule of absRules || []) {
      const eventKey = `abs:${rule.id}`;
      const remindAt = rule.absolute_at as string;
      const { data: existing } = await db
        .from("sent_reminders")
        .select("id")
        .eq("telegram_id", rule.telegram_id)
        .eq("event_id", eventKey)
        .eq("remind_at", remindAt)
        .maybeSingle();
      if (existing) continue;

      await sendMessage(
        rule.telegram_id,
        `⏰ <b>Нагадування</b>\n\n📌 ${
          escapeHtml(rule.title || "Нагадування")
        }`,
      );
      await db.from("sent_reminders").upsert({
        telegram_id: rule.telegram_id,
        event_id: eventKey,
        remind_at: remindAt,
        created_at: new Date().toISOString(),
      }, { onConflict: "telegram_id,event_id,remind_at" });
      // remove one-shot after send
      await db.from("reminder_rules").delete().eq("id", rule.id);
      sent += 1;
    }
  } catch (e) {
    console.error("absolute reminders failed", e);
    errors.push(`absolute: ${e}`);
  }

  for (const user of users) {
    try {
      const rules = await listReminderRules(db, user.telegram_id);
      const beforeMins = rules
        .filter((r) => r.kind === "before" && r.minutes_before)
        .map((r) => r.minutes_before!);
      const perEvent = await listAllEventReminderMap(db, user.telegram_id);
      const due = await eventsNeedingReminder(db, user, beforeMins, 1, perEvent);
      for (const { event, remindAt, minutesBefore } of due) {
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
          `⏰ <b>Нагадування</b> (за ${formatMinutes(minutesBefore)})\n\n` +
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

  try {
    await db.rpc("cleanup_oauth_states");
  } catch {
    // ignore
  }

  return new Response(
    JSON.stringify({ ok: true, users: users.length, sent, errors }),
    { headers: { "Content-Type": "application/json" } },
  );
});

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
