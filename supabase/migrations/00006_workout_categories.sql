-- Add a set-valued categories column (subset of push/pull/legs) for workout sessions.
-- Additive: original `type` column is left intact. full_body expands to all three.
alter table workout_sessions add column if not exists categories text[];

update workout_sessions
set categories = case
  when type = 'full_body' then array['push','pull','legs']
  else string_to_array(type, '_')
end
where categories is null;
