#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/.env"

PROJECT_REF="aulroejrprwekgepitiw"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://${PROJECT_REF}.supabase.co}"
CRON_SECRET="${CRON_SECRET:-$(openssl rand -hex 16)}"
REDIRECT_URI="${PUBLIC_BASE_URL}/functions/v1/oauth-callback"

echo "==> Project: $PROJECT_REF"
echo "==> OAuth redirect: $REDIRECT_URI"
echo "==> Cron secret: $CRON_SECRET"

command -v supabase >/dev/null || { echo "Install Supabase CLI first"; exit 1; }

echo "==> Linking project (if needed)"
supabase link --project-ref "$PROJECT_REF" || true

echo "==> Setting secrets"
supabase secrets set \
  --project-ref "$PROJECT_REF" \
  BOT_TOKEN="$BOT_TOKEN" \
  GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  SUPABASE_SECRET_KEY="$SUPABASE_KEY" \
  SUPABASE_URL="$SUPABASE_URL" \
  PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
  DEFAULT_TIMEZONE="${DEFAULT_TIMEZONE:-Europe/Kyiv}" \
  DEFAULT_REMINDER_MINUTES="${DEFAULT_REMINDER_MINUTES:-30}" \
  CRON_SECRET="$CRON_SECRET"

echo "==> Deploying functions"
supabase functions deploy telegram-webhook --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy oauth-callback --project-ref "$PROJECT_REF" --no-verify-jwt
supabase functions deploy reminders --project-ref "$PROJECT_REF" --no-verify-jwt

WEBHOOK_URL="${PUBLIC_BASE_URL}/functions/v1/telegram-webhook"
echo "==> Setting Telegram webhook: $WEBHOOK_URL"
curl -sS "https://api.telegram.org/bot${BOT_TOKEN}/setWebhook" \
  -d "url=${WEBHOOK_URL}" \
  -d "drop_pending_updates=true" | tee /tmp/eventping-webhook.json
echo

echo ""
echo "DONE."
echo "1) In Google Cloud → OAuth client → Authorized redirect URIs add:"
echo "   $REDIRECT_URI"
echo "2) In Supabase SQL Editor run supabase/schema.sql (if not yet)."
echo "3) In SQL Editor run supabase/cron.sql after replacing REPLACE_WITH_CRON_SECRET with:"
echo "   $CRON_SECRET"
echo "4) Open @eventping_bot → /start"
echo ""
echo "Save CRON_SECRET in .env for later:"
echo "CRON_SECRET=$CRON_SECRET"
