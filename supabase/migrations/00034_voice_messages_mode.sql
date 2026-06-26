-- Per-mode conversation threads: tag each voice_messages row with the mode that produced it ('hub' or
-- 'agent'), so the hub UI can show the ACTIVE mode's conversation and switch live when the agent_mode
-- toggle flips. Existing rows predate the split and are treated as 'hub' (NULL = hub) by readers.
alter table voice_messages add column if not exists mode text;
