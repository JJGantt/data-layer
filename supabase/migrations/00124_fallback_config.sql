-- What the `voice-fallback` edge function needs from the hub to stand in for it when the hub cannot be
-- reached: `hub_token_sha256`, the hash of the hub's device token, to check the watch's X-Hub-Token.
-- The hub writes it at boot from its own environment, so a changed password reaches the function at the
-- next deploy. (The function's Groq key is its own secret, not a row here.)
--
-- RLS on with NO policies: only the service role reads or writes it. Nothing a client holds can see it.
create table if not exists fallback_config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table fallback_config enable row level security;
