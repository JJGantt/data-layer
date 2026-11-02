-- Shared voice-presence: the single source of truth for "who is hearing the user right now," across every
-- mic (ESP, Mac, …). Each source upserts its own row with the last time it heard sound / confirmed the user,
-- ~every 0.7s while active. Any source with a fresh heard_jared_at → the WHOLE system is "Hearing the user",
-- which (a) drives every indicator (ESP LED, Mac HUD, hub/TV) off ONE state and (b) lets a mic that just
-- lost you suppress its partial capture if another mic still has you (no fragments while you're talking).
create table if not exists voice_presence (
  source         text primary key,          -- 'esp' | 'mac'
  heard_sound_at timestamptz,                -- last energy/speech detected (not necessarily the user)
  heard_jared_at timestamptz,                -- last speaker-ID confirmation of the user
  updated_at     timestamptz default now()
);

alter table voice_presence enable row level security;
-- Non-sensitive (timestamps only); every surface reads it and every device upserts it.
drop policy if exists "voice_presence open" on voice_presence;
create policy "voice_presence open" on voice_presence for all using (true) with check (true);

-- Realtime: full row on UPDATE so subscribers get heard_jared_at without a re-fetch.
alter table voice_presence replica identity full;
alter publication supabase_realtime add table voice_presence;

insert into voice_presence (source) values ('esp'), ('mac') on conflict (source) do nothing;
