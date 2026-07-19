-- Per-event reminder overrides (run once in SQL Editor)

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

alter table event_reminders enable row level security;
