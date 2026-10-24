-- REWIND GRABS — every grab the watch's rewind sends, kept whole while the feature is being built.
--
-- The hub writes one row per grab from /api/rewind (status-hub server.js, docs/REWIND.md): the clip in
-- the voice-clips bucket under rewind/, what each transcriber made of it, and how long it took. A
-- command sent with a grab attached names it in voice_requests.rewind_id. Nothing sweeps it: these are
-- the record for judging transcription quality, so they stay until someone decides otherwise.
create table if not exists rewind_grabs (
  id uuid primary key,
  at timestamptz not null default now(),
  held_s real,
  audio jsonb,
  model text,
  transcript text,
  segments jsonb,
  error text,
  ms integer
);
create index if not exists rewind_grabs_at on rewind_grabs (at desc);
alter table rewind_grabs enable row level security;

alter table voice_requests add column if not exists rewind_id uuid references rewind_grabs (id);
