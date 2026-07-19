# EventPing (`@eventping_bot`)

Telegram-бот для Google Calendar: нагадування та швидке створення подій.

Працює з **Supabase** у хмарі — бот може крутитись 24/7 на Railway / Fly.io, не лише на твоєму комп’ютері.

## Що вміє

- підключення Google Calendar (OAuth з публічним callback)
- список найближчих подій
- нагадування за N хвилин
- створення подій текстом українською
- зберігання користувачів і токенів у Supabase

## Локальний запуск

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m bot
```

## Supabase

Проєкт: `https://aulroejrprwekgepitiw.supabase.co`

1. У [SQL Editor](https://supabase.com/dashboard/project/aulroejrprwekgepitiw/sql) виконай `supabase/schema.sql` (якщо ще не виконував).
2. У `.env` мають бути:

```env
DB_BACKEND=supabase
SUPABASE_URL=https://aulroejrprwekgepitiw.supabase.co
SUPABASE_KEY=sb_secret_...
```

## Деплой 24/7 (рекомендовано Railway)

Щоб бот відповідав завжди і Google OAuth працював з телефону — потрібен публічний URL.

### 1. Залий код на GitHub

Створи репозиторій і запуш цей проєкт (файл `.env` у git не потрапляє).

### 2. Railway

1. Зайди на [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**.
2. Обрай репозиторій.
3. У **Variables** додай:

| Variable | Значення |
|---|---|
| `BOT_TOKEN` | токен від BotFather |
| `GOOGLE_CLIENT_ID` | з Google Cloud |
| `GOOGLE_CLIENT_SECRET` | з Google Cloud |
| `DB_BACKEND` | `supabase` |
| `SUPABASE_URL` | `https://aulroejrprwekgepitiw.supabase.co` |
| `SUPABASE_KEY` | твій `sb_secret_...` |
| `DEFAULT_TIMEZONE` | `Europe/Kyiv` |
| `OAUTH_HOST` | `0.0.0.0` |

4. Після деплою відкрий **Settings → Networking → Generate Domain**.
5. Додай змінну:

```env
PUBLIC_BASE_URL=https://твій-домен.up.railway.app
```

6. Передеплой (або Restart).

### 3. Google Cloud — redirect URI

У [Google Cloud Console](https://console.cloud.google.com/) → Credentials → твій OAuth Web client → **Authorized redirect URIs** додай:

```
https://твій-домен.up.railway.app/oauth/callback
```

(Можеш залишити й `http://localhost:8080/oauth/callback` для локальних тестів.)

### 4. Перевірка

- Відкрий `https://твій-домен.up.railway.app/health` → має бути `ok`
- У Telegram: `/start` → **Підключити календар**

### Альтернатива: Fly.io

```bash
fly launch
fly secrets set BOT_TOKEN=... GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
  SUPABASE_URL=https://aulroejrprwekgepitiw.supabase.co SUPABASE_KEY=... \
  DB_BACKEND=supabase PUBLIC_BASE_URL=https://eventping-bot.fly.dev
fly deploy
```

Потім той самий URL додай у Google redirect URIs.

> **Не використовуй безкоштовний Render Web Service для цього бота** — він «засинає» без трафіку, і нагадування перестануть приходити.

## Команди в боті

| Дія | Як |
|---|---|
| Старт | `/start` |
| Календар | `🔗 Підключити календар` |
| Події | `📅 Найближчі` |
| Нова подія | `➕ Нова подія` або текст на кшталт `Завтра 15:00 Зустріч` |
| Налаштування | `⚙️ Налаштування` |

Приклади:

```
Завтра 15:00 Зустріч з клієнтом
21.07 18:30 Вечеря @Кафе
Через 2 години Дзвінок
В п'ятницю 10:00 Планерка
```
