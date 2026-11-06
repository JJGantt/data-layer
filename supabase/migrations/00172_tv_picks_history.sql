-- TV PICKS HISTORY — the whole picks screen (00171) as it stood after each change, so an earlier
-- state can be looked at and restored (data-layer tvPicks.ts `history` / `history_view` / `restore`).
-- One row per change; `state` is every shelf with its items, a few KB. Never pruned.
create table if not exists tv_picks_history (
  id bigserial primary key,
  at timestamptz not null default now(),
  summary text not null,
  state jsonb not null
);
alter table tv_picks_history enable row level security;
