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

export function getEnv(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

export function adminClient(): SupabaseClient {
  const url = getEnv("SUPABASE_URL");
  const key = getEnv("SUPABASE_SECRET_KEY") ||
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
    return data as DbUser;
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
  return data as DbUser;
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
