# EventPing (`@eventping_bot`)

Telegram-бот для Google Calendar. **Хостинг 24/7 — безкоштовно на Supabase Edge Functions** (без Railway).

## Як це працює постійно і безкоштовно

| Частина | Де |
|---|---|
| База + токени | Supabase Postgres |
| Обробка повідомлень | Edge Function `telegram-webhook` |
| Google OAuth | Edge Function `oauth-callback` |
| Нагадування щохвилини | Edge Function `reminders` + `pg_cron` |

Python-код у `bot/` лишився для локальних експериментів. **Продакшен = Supabase Functions.**

## 1. SQL (один раз)

У [SQL Editor](https://supabase.com/dashboard/project/aulroejrprwekgepitiw/sql) виконай:

1. `supabase/schema.sql`
2. Після деплою — `supabase/cron.sql` (підставивши `CRON_SECRET`)

## 2. Google redirect URI

У Google Cloud → OAuth Web client → **Authorized redirect URIs**:

```
https://aulroejrprwekgepitiw.supabase.co/functions/v1/oauth-callback
```

## 3. Деплой

Потрібні [Supabase CLI](https://supabase.com/docs/guides/cli) і логін:

```bash
supabase login
chmod +x scripts/deploy-supabase.sh
./scripts/deploy-supabase.sh
```

Скрипт:
- виставить secrets з `.env`
- задеплоїть 3 functions
- підключить Telegram webhook

Перевір webhook:

```bash
curl "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo"
```

Має бути URL:
`https://aulroejrprwekgepitiw.supabase.co/functions/v1/telegram-webhook`

## 4. Cron для нагадувань

У `supabase/cron.sql` заміни `REPLACE_WITH_CRON_SECRET` на значення, яке вивів deploy-скрипт, і виконай SQL.

Або в Dashboard: **Integrations → Cron** → кожну хвилину POST на  
`/functions/v1/reminders` з хедером `x-cron-secret`.

## Команди в боті

| Дія | Як |
|---|---|
| Старт | `/start` |
| Календар | `🔗 Підключити календар` |
| Події | `📅 Найближчі` |
| Нова подія | `➕ Нова подія` → дата → час → назва |
| Нагадування | кілька штук: «за N до події» або точна дата/час |
| Налаштування | `⚙️ Налаштування` |

Час: `15`, `15:00`, `15 00`, `8:30`, `08:30`, `8 30`, `08 30`.

## Локальний Python (опційно)

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m bot
```

Для постійної роботи використовуй Edge Functions, не локальний процес.
