import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

export type DbUser = {
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  timezone: string;
  reminder_minutes: number;
  google_refresh_token: string | null;
  google_token_expiry: string | null;
  google_access_token: string | null;
  calendar_id: string;
  is_active: boolean;
};

export type ReminderRule = {
  id: number;
  telegram_id: number;
  kind: "before" | "absolute";
  minutes_before: number | null;
  absolute_at: string | null;
  title: string | null;
};

export function getEnv(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

export function adminClient(): SupabaseClient {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SERVICE_KEY") ||
    getEnv("SUPABASE_SERVICE_ROLE_KEY") ||
    getEnv("SUPABASE_KEY");
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or secret key");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function upsertUser(
  db: SupabaseClient,
  tg: { id: number; username?: string; first_name?: string },
): Promise<DbUser> {
  const existing = await getUser(db, tg.id);
  const now = new Date().toISOString();
  if (existing) {
    const { data, error } = await db
      .from("users")
      .update({
        username: tg.username ?? null,
        first_name: tg.first_name ?? null,
        is_active: true,
        updated_at: now,
      })
      .eq("telegram_id", tg.id)
      .select("*")
      .single();
    if (error) throw error;
    const user = data as DbUser;
    await ensureDefaultReminder(db, user.telegram_id, user.reminder_minutes);
    return user;
  }
  const { data, error } = await db
    .from("users")
    .insert({
      telegram_id: tg.id,
      username: tg.username ?? null,
      first_name: tg.first_name ?? null,
      timezone: getEnv("DEFAULT_TIMEZONE", "Europe/Kyiv"),
      reminder_minutes: Number(getEnv("DEFAULT_REMINDER_MINUTES", "30")),
      calendar_id: "primary",
      is_active: true,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  if (error) throw error;
  const user = data as DbUser;
  await ensureDefaultReminder(db, user.telegram_id, user.reminder_minutes);
  return user;
}

export async function getUser(
  db: SupabaseClient,
  telegramId: number,
): Promise<DbUser | null> {
  const { data, error } = await db
    .from("users")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  return (data as DbUser) ?? null;
}

export async function updateUser(
  db: SupabaseClient,
  telegramId: number,
  fields: Record<string, unknown>,
): Promise<DbUser> {
  const { data, error } = await db
    .from("users")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("telegram_id", telegramId)
    .select("*")
    .single();
  if (error) throw error;
  return data as DbUser;
}

export async function listConnectedUsers(db: SupabaseClient): Promise<DbUser[]> {
  const { data, error } = await db
    .from("users")
    .select("*")
    .eq("is_active", true)
    .not("google_refresh_token", "is", null);
  if (error) throw error;
  return ((data as DbUser[]) ?? []).filter((u) => !!u.google_refresh_token);
}

export async function setSession(
  db: SupabaseClient,
  telegramId: number,
  state: string | null,
  data: Record<string, unknown> = {},
) {
  const { error } = await db.from("bot_sessions").upsert({
    telegram_id: telegramId,
    state,
    data,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

export async function getSession(db: SupabaseClient, telegramId: number) {
  const { data, error } = await db
    .from("bot_sessions")
    .select("*")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  if (error) throw error;
  return data as { state: string | null; data: Record<string, unknown> } | null;
}

export async function clearSession(db: SupabaseClient, telegramId: number) {
  await setSession(db, telegramId, null, {});
}

export async function listReminderRules(
  db: SupabaseClient,
  telegramId: number,
): Promise<ReminderRule[]> {
  const { data, error } = await db
    .from("reminder_rules")
    .select("*")
    .eq("telegram_id", telegramId)
    .order("id", { ascending: true });
  if (error) throw error;
  return (data as ReminderRule[]) ?? [];
}

export async function ensureDefaultReminder(
  db: SupabaseClient,
  telegramId: number,
  minutes = 30,
) {
  const rules = await listReminderRules(db, telegramId);
  if (rules.length) return;
  await db.from("reminder_rules").insert({
    telegram_id: telegramId,
    kind: "before",
    minutes_before: minutes,
  });
}

export async function addBeforeReminder(
  db: SupabaseClient,
  telegramId: number,
  minutes: number,
): Promise<ReminderRule> {
  const { data, error } = await db
    .from("reminder_rules")
    .insert({
      telegram_id: telegramId,
      kind: "before",
      minutes_before: minutes,
    })
    .select("*")
    .single();
  if (error) throw error;
  // keep legacy field in sync with first before-rule
  await syncLegacyReminderMinutes(db, telegramId);
  return data as ReminderRule;
}

export async function addAbsoluteReminder(
  db: SupabaseClient,
  telegramId: number,
  absoluteAt: string,
  title: string,
): Promise<ReminderRule> {
  const { data, error } = await db
    .from("reminder_rules")
    .insert({
      telegram_id: telegramId,
      kind: "absolute",
      absolute_at: absoluteAt,
      title,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as ReminderRule;
}

export async function deleteReminderRule(
  db: SupabaseClient,
  telegramId: number,
  ruleId: number,
) {
  const { error } = await db
    .from("reminder_rules")
    .delete()
    .eq("telegram_id", telegramId)
    .eq("id", ruleId);
  if (error) throw error;
  await syncLegacyReminderMinutes(db, telegramId);
}

async function syncLegacyReminderMinutes(
  db: SupabaseClient,
  telegramId: number,
) {
  const rules = await listReminderRules(db, telegramId);
  const first = rules.find((r) => r.kind === "before" && r.minutes_before);
  if (first?.minutes_before) {
    await updateUser(db, telegramId, { reminder_minutes: first.minutes_before });
  }
}

export async function listEventReminders(
  db: SupabaseClient,
  telegramId: number,
  eventId: string,
): Promise<number[]> {
  const { data, error } = await db
    .from("event_reminders")
    .select("minutes_before")
    .eq("telegram_id", telegramId)
    .eq("event_id", eventId)
    .order("minutes_before", { ascending: true });
  if (error) throw error;
  return ((data || []) as Array<{ minutes_before: number }>).map((r) =>
    r.minutes_before
  );
}

export async function listAllEventReminderMap(
  db: SupabaseClient,
  telegramId: number,
): Promise<Record<string, number[]>> {
  const { data, error } = await db
    .from("event_reminders")
    .select("event_id, minutes_before")
    .eq("telegram_id", telegramId);
  if (error) throw error;
  const map: Record<string, number[]> = {};
  for (const row of data || []) {
    const id = String(row.event_id);
    if (!map[id]) map[id] = [];
    map[id].push(Number(row.minutes_before));
  }
  return map;
}

export async function setEventReminders(
  db: SupabaseClient,
  telegramId: number,
  eventId: string,
  minutesList: number[],
) {
  await db.from("event_reminders").delete()
    .eq("telegram_id", telegramId)
    .eq("event_id", eventId);
  const unique = [...new Set(minutesList.filter((m) => m > 0))];
  if (!unique.length) return;
  const { error } = await db.from("event_reminders").insert(
    unique.map((minutes_before) => ({
      telegram_id: telegramId,
      event_id: eventId,
      minutes_before,
    })),
  );
  if (error) throw error;
}

export async function addEventReminder(
  db: SupabaseClient,
  telegramId: number,
  eventId: string,
  minutes: number,
) {
  const { error } = await db.from("event_reminders").upsert({
    telegram_id: telegramId,
    event_id: eventId,
    minutes_before: minutes,
  }, { onConflict: "telegram_id,event_id,minutes_before" });
  if (error) throw error;
}

export async function removeEventReminder(
  db: SupabaseClient,
  telegramId: number,
  eventId: string,
  minutes: number,
) {
  const { error } = await db.from("event_reminders").delete()
    .eq("telegram_id", telegramId)
    .eq("event_id", eventId)
    .eq("minutes_before", minutes);
  if (error) throw error;
}
