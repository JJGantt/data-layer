-- Which engine wrote an assistant reply when it was not the Claude subscription: 'credits' (the
-- Console API key, at the subscription's usage limit) or 'codex' (Claude unavailable). Null is the
-- subscription. The voice worker sets it; every surface colours the reply by it.
alter table public.voice_messages add column if not exists engine text;
