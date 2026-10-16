-- What the `voice-fallback` edge function needs to stand in for the hub when the hub cannot be reached:
-- the hash of the hub's device token (to check the watch's X-Hub-Token) and the Groq key (to transcribe
-- the clip). The hub writes both at boot from its own environment, so neither is copied by hand and a
-- rotated value reaches the function at the next deploy.
--
-- RLS on with NO policies: only the service role reads or writes it. Nothing a client holds can see it.
create table if not exists fallback_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table fallback_config enable row level security;
