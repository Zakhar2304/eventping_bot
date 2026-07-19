-- Run once if schema.sql was applied earlier without reminder_rules

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

alter table reminder_rules enable row level security;

insert into reminder_rules (telegram_id, kind, minutes_before)
select u.telegram_id, 'before', coalesce(u.reminder_minutes, 30)
from users u
where not exists (
  select 1 from reminder_rules r where r.telegram_id = u.telegram_id
);
