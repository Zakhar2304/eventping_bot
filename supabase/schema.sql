-- EventPing schema — run in SQL Editor
-- https://supabase.com/dashboard/project/aulroejrprwekgepitiw/sql

create table if not exists users (
  telegram_id bigint primary key,
  username text,
  first_name text,
  timezone text not null default 'Europe/Kyiv',
  reminder_minutes integer not null default 30,
  google_refresh_token text,
  google_token_expiry timestamptz,
  google_access_token text,
  calendar_id text not null default 'primary',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists sent_reminders (
  id bigserial primary key,
  telegram_id bigint not null references users(telegram_id) on delete cascade,
  event_id text not null,
  remind_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (telegram_id, event_id, remind_at)
);

create table if not exists bot_sessions (
  telegram_id bigint primary key references users(telegram_id) on delete cascade,
  state text,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists oauth_states (
  state text primary key,
  telegram_id bigint not null references users(telegram_id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Multiple reminders: before event OR absolute datetime
create table if not exists reminder_rules (
  id bigserial primary key,
  telegram_id bigint not null references users(telegram_id) on delete cascade,
  kind text not null check (kind in ('before', 'absolute')),
  minutes_before integer,
  absolute_at timestamptz,
  title text,
  created_at timestamptz not null default now(),
  constraint reminder_rules_shape check (
    (kind = 'before' and minutes_before is not null and minutes_before > 0)
    or (kind = 'absolute' and absolute_at is not null)
  )
);

create index if not exists idx_reminder_rules_user
  on reminder_rules (telegram_id);

create index if not exists idx_reminder_rules_absolute
  on reminder_rules (absolute_at)
  where kind = 'absolute';

create table if not exists event_reminders (
  id bigserial primary key,
  telegram_id bigint not null references users(telegram_id) on delete cascade,
  event_id text not null,
  minutes_before integer not null check (minutes_before > 0),
  created_at timestamptz not null default now(),
  unique (telegram_id, event_id, minutes_before)
);

create index if not exists idx_event_reminders_user_event
  on event_reminders (telegram_id, event_id);

create index if not exists idx_users_active_connected
  on users (is_active)
  where google_refresh_token is not null;

create index if not exists idx_sent_reminders_lookup
  on sent_reminders (telegram_id, event_id);

create index if not exists idx_oauth_states_created
  on oauth_states (created_at);

alter table users enable row level security;
alter table sent_reminders enable row level security;
alter table bot_sessions enable row level security;
alter table oauth_states enable row level security;
alter table reminder_rules enable row level security;
alter table event_reminders enable row level security;

-- Seed default "30 хв до" for users who have no rules yet
insert into reminder_rules (telegram_id, kind, minutes_before)
select u.telegram_id, 'before', coalesce(u.reminder_minutes, 30)
from users u
where not exists (
  select 1 from reminder_rules r where r.telegram_id = u.telegram_id
);

create or replace function cleanup_oauth_states()
returns void
language sql
security definer
as $$
  delete from oauth_states where created_at < now() - interval '1 hour';
$$;
