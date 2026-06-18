-- Flat, timestamped sets model. Replaces the session -> exercise -> set hierarchy for
-- going-forward logging. The OLD tables (workout_sessions, exercises, exercise_sets) are
-- LEFT INTACT here on purpose — they are dropped only after the new model is verified.
--
-- Muscle mapping stays normalized in exercise_muscles (joined at read time). A set may carry
-- an optional muscles_override only for a true one-off exercise that isn't worth cataloging.

CREATE TABLE IF NOT EXISTS sets (
    id          BIGSERIAL PRIMARY KEY,
    occurred_at TEXT    NOT NULL,           -- naive local 'YYYY-MM-DDTHH:MM:SS' (matches nutrition)
    exercise    TEXT    NOT NULL,
    weight_lbs  REAL    NOT NULL,
    reps        INTEGER NOT NULL,
    muscles_override JSONB                  -- normally NULL; muscles resolve via exercise_muscles
);
CREATE INDEX IF NOT EXISTS sets_occurred_at_idx ON sets(occurred_at);
CREATE INDEX IF NOT EXISTS sets_exercise_idx ON sets(exercise);
ALTER TABLE sets DISABLE ROW LEVEL SECURITY;

-- Migrate history: each exercise_set becomes a sets row, timestamped from its session's start
-- time and staggered by (sort_order, set_num) so order is preserved and timestamps stay distinct.
INSERT INTO sets (occurred_at, exercise, weight_lbs, reps)
SELECT to_char(
         (ws.date)::timestamp
           + ((row_number() OVER (PARTITION BY ws.id ORDER BY e.sort_order, es.set_num)) - 1) * interval '15 seconds',
         'YYYY-MM-DD"T"HH24:MI:SS'),
       e.name, es.weight_lbs, es.reps
FROM exercise_sets es
JOIN exercises e         ON e.id = es.exercise_id
JOIN workout_sessions ws ON ws.id = e.session_id;

-- Realtime so the hub gets pushes on new sets (mirrors the other live tables).
ALTER PUBLICATION supabase_realtime ADD TABLE sets;
