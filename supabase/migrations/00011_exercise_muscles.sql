-- Canonical exercise catalog + fractional muscle maps for hypertrophy volume tracking.
-- Counting model: fractional set counting (1.0 primary mover, 0.5 meaningful secondary, 0 stabilizer).
-- Taxonomy: 20 high-fidelity muscle regions (see exercise_muscles seed below).

-- 1. Schema -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS exercise_catalog (
    name       TEXT PRIMARY KEY,
    categories TEXT[] NOT NULL
);
ALTER TABLE exercise_catalog DISABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS exercise_muscles (
    name         TEXT NOT NULL REFERENCES exercise_catalog(name) ON DELETE CASCADE ON UPDATE CASCADE,
    muscle       TEXT NOT NULL,
    contribution REAL NOT NULL CHECK (contribution > 0 AND contribution <= 1),
    PRIMARY KEY (name, muscle)
);
ALTER TABLE exercise_muscles DISABLE ROW LEVEL SECURITY;

-- 2. Historical data cleanup ------------------------------------------------

-- 2a. Flip the three recent bodyweight sessions (May 22 / May 25 / Jun 1) from
--     forward Lunges to Reverse Lunges — these were logged as "Lunges" but were
--     actually reverse lunges.
UPDATE exercises SET name = 'Reverse Lunges'
 WHERE id IN ('8ea9adbb-4543-47d5-bccd-1b7781e37de9',
              'd281d354-f395-49b7-8281-d096f6c07c27',
              '8363df5a-f1df-4b6f-8ef8-82494f53ffd8');

-- 2b. Merge the two duplicate "Squats (Dumbbell)" rows in session 44d6e85a
--     (2026-03-10) into the earlier one, then renumber its sets.
UPDATE exercise_sets SET exercise_id = 'ad7df9bb-840b-4563-85fd-f2bb941c0d52'
 WHERE exercise_id = 'd0771c7b-f704-44e5-986e-2ff923a6ce17';
DELETE FROM exercises WHERE id = 'd0771c7b-f704-44e5-986e-2ff923a6ce17';
WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY set_num, id) AS rn
      FROM exercise_sets WHERE exercise_id = 'ad7df9bb-840b-4563-85fd-f2bb941c0d52'
)
UPDATE exercise_sets s SET set_num = o.rn FROM ordered o WHERE s.id = o.id;

-- 2c. Collapse historical exercise names to canonical spellings. Equipment
--     qualifiers (dumbbell / ring) are dropped — weight_lbs already carries load,
--     and bodyweight (0) signals the bodyweight/ring variant.
UPDATE exercises SET name = 'Squats'             WHERE lower(name) IN ('squat','squats','dumbbell squats','squats (dumbbell)');
UPDATE exercises SET name = 'Push-Ups'           WHERE lower(name) = 'push-ups';
UPDATE exercises SET name = 'Pull-Ups'           WHERE lower(name) = 'pull-ups';
UPDATE exercises SET name = 'Reverse Lunges'     WHERE lower(name) = 'reverse lunge';
UPDATE exercises SET name = 'Romanian Deadlifts' WHERE lower(name) IN ('romanian deadlift','romanian deadlifts');
UPDATE exercises SET name = 'Rows'               WHERE lower(name) IN ('ring rows','rows');
UPDATE exercises SET name = 'Face Pulls'         WHERE lower(name) IN ('ring face pulls','face pulls');
UPDATE exercises SET name = 'Shrugs'             WHERE lower(name) IN ('shrugs','dumbbell shrugs');
UPDATE exercises SET name = 'Curls'              WHERE lower(name) IN ('curls','dumbbell curls');
UPDATE exercises SET name = 'Incline Curls'      WHERE lower(name) IN ('incline curls','incline dumbbell curls');
UPDATE exercises SET name = 'Chest Fly'          WHERE lower(name) IN ('dumbbell chest fly','dumbbell flyes');
UPDATE exercises SET name = 'Chest Press'        WHERE lower(name) = 'dumbbell press';
UPDATE exercises SET name = 'Incline Press'      WHERE lower(name) IN ('incline press','incline dumbbell press');
UPDATE exercises SET name = 'Shoulder Press'     WHERE lower(name) IN ('shoulder press','dumbbell shoulder press');
UPDATE exercises SET name = 'Side Bends'         WHERE lower(name) = 'dumbbell side bends';

-- 3. Seed canonical catalog + fractional muscle maps ------------------------

INSERT INTO exercise_catalog (name, categories) VALUES
    ('Squats',                    ARRAY['legs']),
    ('Lunges',                    ARRAY['legs']),
    ('Reverse Lunges',            ARRAY['legs']),
    ('Romanian Deadlifts',        ARRAY['pull','legs']),
    ('Glute Bridges',             ARRAY['legs']),
    ('Calf Raises',               ARRAY['legs']),
    ('Ring-Assisted Squats',      ARRAY['legs','pull']),
    ('Push-Ups',                  ARRAY['push']),
    ('Chest Press',               ARRAY['push']),
    ('Incline Press',             ARRAY['push']),
    ('Chest Fly',                 ARRAY['push']),
    ('Shoulder Press',            ARRAY['push']),
    ('Lateral Raises',            ARRAY['push']),
    ('Face Pulls',                ARRAY['pull']),
    ('Overhead Tricep Extension', ARRAY['push']),
    ('Skull Crushers',            ARRAY['push']),
    ('Pull-Ups',                  ARRAY['pull']),
    ('Rows',                      ARRAY['pull']),
    ('Shrugs',                    ARRAY['pull']),
    ('Curls',                     ARRAY['pull']),
    ('Incline Curls',             ARRAY['pull']),
    ('Hammer Curls',              ARRAY['pull']),
    ('Leg Raises',                ARRAY['core']),
    ('Side Bends',                ARRAY['core'])
ON CONFLICT (name) DO UPDATE SET categories = EXCLUDED.categories;

INSERT INTO exercise_muscles (name, muscle, contribution) VALUES
    ('Squats',                    'quads',           1.0),
    ('Squats',                    'glutes',          0.5),
    ('Lunges',                    'quads',           1.0),
    ('Lunges',                    'glutes',          0.5),
    ('Reverse Lunges',            'glutes',          1.0),
    ('Reverse Lunges',            'quads',           0.5),
    ('Reverse Lunges',            'hamstrings',      0.5),
    ('Romanian Deadlifts',        'hamstrings',      1.0),
    ('Romanian Deadlifts',        'glutes',          0.5),
    ('Glute Bridges',             'glutes',          1.0),
    ('Glute Bridges',             'hamstrings',      0.5),
    ('Calf Raises',               'gastrocnemius',   1.0),
    ('Ring-Assisted Squats',      'quads',           0.5),
    ('Ring-Assisted Squats',      'glutes',          0.5),
    ('Ring-Assisted Squats',      'lats',            0.5),
    ('Ring-Assisted Squats',      'biceps',          0.5),
    ('Push-Ups',                  'lower_chest',     1.0),
    ('Push-Ups',                  'triceps_lateral', 0.5),
    ('Push-Ups',                  'front_delts',     0.5),
    ('Chest Press',               'lower_chest',     1.0),
    ('Chest Press',               'triceps_lateral', 0.5),
    ('Chest Press',               'front_delts',     0.5),
    ('Incline Press',             'upper_chest',     1.0),
    ('Incline Press',             'front_delts',     0.5),
    ('Incline Press',             'triceps_lateral', 0.5),
    ('Chest Fly',                 'lower_chest',     1.0),
    ('Shoulder Press',            'front_delts',     1.0),
    ('Shoulder Press',            'side_delts',      0.5),
    ('Shoulder Press',            'triceps_lateral', 0.5),
    ('Lateral Raises',            'side_delts',      1.0),
    ('Face Pulls',                'rear_delts',      1.0),
    ('Face Pulls',                'mid_back',        0.5),
    ('Overhead Tricep Extension', 'triceps_long',    1.0),
    ('Skull Crushers',            'triceps_lateral', 1.0),
    ('Skull Crushers',            'triceps_long',    0.5),
    ('Pull-Ups',                  'lats',            1.0),
    ('Pull-Ups',                  'biceps',          0.5),
    ('Rows',                      'lats',            1.0),
    ('Rows',                      'mid_back',        0.5),
    ('Rows',                      'biceps',          0.5),
    ('Rows',                      'rear_delts',      0.5),
    ('Shrugs',                    'upper_traps',     1.0),
    ('Curls',                     'biceps',          1.0),
    ('Curls',                     'forearms',        0.5),
    ('Incline Curls',             'biceps',          1.0),
    ('Hammer Curls',              'biceps',          1.0),
    ('Hammer Curls',              'forearms',        0.5),
    ('Leg Raises',                'abs',             1.0),
    ('Side Bends',                'obliques',        1.0)
ON CONFLICT (name, muscle) DO UPDATE SET contribution = EXCLUDED.contribution;

-- 4. Reload PostgREST schema cache.
NOTIFY pgrst, 'reload schema';
