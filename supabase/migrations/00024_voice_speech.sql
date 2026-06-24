-- Audio channel for the assistant's single spoken line. The `say` MCP tool (mcp-voice) inserts one
-- short present-tense utterance per voice turn — e.g. "changing the floor lamp to white" — and every
-- speaker-equipped surface (the Mac listener today) subscribes via realtime and plays it the instant
-- it lands. This is a SEPARATE stream from voice_messages (the display thread) and from push_activity
-- (the visual activity bar); ONLY voice_speech is played aloud. Feedback is universal: it is not
-- scoped to whichever input captured the command. See voice-pipeline/ARCHITECTURE.md.
create table if not exists voice_speech (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  source text,                            -- optional: which worker/source produced it (observability)
  created_at timestamptz not null default now()
);

alter table voice_speech enable row level security;  -- service_role only (no anon policy)

-- Publish on realtime so speaker surfaces play each line the instant it's inserted.
do $$ begin
  alter publication supabase_realtime add table voice_speech;
exception when duplicate_object then null; end $$;
