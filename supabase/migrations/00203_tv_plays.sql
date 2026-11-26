-- TV PLAYS — everything that played on the bedroom TV, whoever started it (google-tv docs/WATCHING.md).
--
-- The TV's companion app watches its media sessions (PlayWatcher) and posts each title change, pause and
-- stop to the hub's /api/tv/play, which writes here. It is what keeps a pick from repeating something he
-- just watched, and what he watched there in Netflix, Prime and the rest, which no YouTube history has.
--
-- `id` is minted by the app, one per title it sees, so a repeated post is the same row. `watched_s` is
-- the furthest position seen; `ended_at` stays null while it is still on (or the TV went off before
-- saying so, which the next play closes). `url`, `video_id` and `command_id` are filled when the play
-- followed an `open` command (voice, a session, the phone's TV Guide), from that command's url.
create table if not exists tv_plays (
  id uuid primary key,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,
  package text not null,
  title text,
  artist text,
  duration_s integer,
  watched_s integer not null default 0,
  url text,
  video_id text,
  command_id uuid references tv_commands(id) on delete set null
);
create index if not exists tv_plays_started on tv_plays (started_at desc);
create index if not exists tv_plays_video on tv_plays (video_id) where video_id is not null;
alter table tv_plays enable row level security;
