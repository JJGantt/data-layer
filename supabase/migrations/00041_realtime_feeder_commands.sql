-- The Pi feeder collector now wakes on realtime INSERTs instead of polling every 5s — the table
-- must be in the publication for those events to fire ("Feed Now" dispenses instantly; a slow
-- backstop poll covers a missed event).
alter publication supabase_realtime add table public.feeder_commands;
