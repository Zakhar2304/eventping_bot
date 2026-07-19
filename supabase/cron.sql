-- After Edge Functions are deployed, run this in SQL Editor
-- to ping reminders every minute (Supabase free: pg_cron + pg_net).

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Replace CRON_SECRET below with the same value you set in Edge Function secrets.
-- Project ref is already filled.

select cron.unschedule('eventping-reminders')
where exists (
  select 1 from cron.job where jobname = 'eventping-reminders'
);

select cron.schedule(
  'eventping-reminders',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://aulroejrprwekgepitiw.supabase.co/functions/v1/reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', 'REPLACE_WITH_CRON_SECRET'
    ),
    body := '{}'::jsonb
  );
  $$
);
