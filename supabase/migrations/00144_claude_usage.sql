-- The Claude subscription's usage windows, one row per CHANGE. The newest row is the current reading;
-- the rest is the history the session gate (data-layer desk.ts) measures the orchestrator's own burn
-- rate from, so its reserve comes from what voice turns actually cost rather than a guessed constant.
--
-- Writers report after every turn they run: the voice worker from the `rate_limit_event` each SDK turn
-- emits, and the Stop hook on the Mac and the Pi (claude-config shared/bin/claude-usage-report) from
-- /api/oauth/usage. Most reports repeat the last reading, so the trigger below drops a row identical to
-- the newest one. Without it the table would grow with every turn and, being in the realtime
-- publication, broadcast every turn to every open screen.
create table if not exists public.claude_usage (
  id bigint generated always as identity primary key,
  observed_at timestamptz not null default now(),
  source text not null,                 -- 'worker:<id>' | 'hook:<machine>'
  five_hour_pct numeric not null,       -- 0-100
  five_hour_resets_at timestamptz,
  seven_day_pct numeric not null,       -- 0-100
  seven_day_resets_at timestamptz,
  status text                           -- 'allowed' | 'allowed_warning' | 'rejected', when the writer knows it
);

create index if not exists claude_usage_observed_at on public.claude_usage (observed_at desc);

create or replace function public.claude_usage_skip_repeat() returns trigger
language plpgsql as $$
declare
  last public.claude_usage;
begin
  select * into last from public.claude_usage order by observed_at desc, id desc limit 1;
  if found
     and last.five_hour_pct = new.five_hour_pct
     and last.seven_day_pct = new.seven_day_pct
     and last.five_hour_resets_at is not distinct from new.five_hour_resets_at
     and last.seven_day_resets_at is not distinct from new.seven_day_resets_at
     and coalesce(last.status, '') = coalesce(new.status, coalesce(last.status, '')) then
    return null;
  end if;
  return new;
end $$;

drop trigger if exists claude_usage_skip_repeat on public.claude_usage;
create trigger claude_usage_skip_repeat before insert on public.claude_usage
  for each row execute function public.claude_usage_skip_repeat();

alter table public.claude_usage enable row level security;

alter publication supabase_realtime add table public.claude_usage;
