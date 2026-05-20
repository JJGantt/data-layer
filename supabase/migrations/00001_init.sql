-- Life-data schema init migration

CREATE TABLE lists (
    name    TEXT PRIMARY KEY,
    created TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE list_items (
    id        TEXT    PRIMARY KEY,
    list_name TEXT    NOT NULL REFERENCES lists(name),
    text      TEXT    NOT NULL,
    done      BOOLEAN NOT NULL DEFAULT false,
    deleted   BOOLEAN NOT NULL DEFAULT false,
    created   TEXT    NOT NULL,
    updated   TEXT    NOT NULL
);

CREATE INDEX list_items_list_name_idx ON list_items(list_name);

CREATE TABLE reminders (
    id      TEXT    PRIMARY KEY,
    text    TEXT    NOT NULL,
    due     TEXT,
    done    BOOLEAN NOT NULL DEFAULT false,
    deleted BOOLEAN NOT NULL DEFAULT false,
    created TEXT    NOT NULL,
    updated TEXT    NOT NULL
);

CREATE TABLE notes (
    name    TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    updated TEXT NOT NULL
);

CREATE TABLE health_profile (
    id        INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    height_in REAL,
    updated   TEXT
);

CREATE TABLE weight_log (
    id         BIGSERIAL PRIMARY KEY,
    date       TEXT NOT NULL,
    weight_lbs REAL NOT NULL,
    logged_at  TEXT NOT NULL
);

CREATE TABLE nutrition_targets (
    id        BIGSERIAL PRIMARY KEY,
    date      TEXT NOT NULL,
    calories  REAL NOT NULL,
    protein_g REAL NOT NULL,
    carbs_g   REAL NOT NULL,
    fat_g     REAL NOT NULL,
    logged_at TEXT NOT NULL
);

CREATE TABLE workout_sessions (
    id    TEXT PRIMARY KEY,
    date  TEXT NOT NULL,
    type  TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE exercises (
    id         TEXT    PRIMARY KEY,
    session_id TEXT    NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
    name       TEXT    NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX exercises_session_id_idx ON exercises(session_id);

CREATE TABLE exercise_sets (
    id          BIGSERIAL PRIMARY KEY,
    exercise_id TEXT    NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
    set_num     INTEGER NOT NULL,
    weight_lbs  REAL    NOT NULL,
    reps        INTEGER NOT NULL
);

CREATE INDEX exercise_sets_exercise_id_idx ON exercise_sets(exercise_id);

CREATE TABLE recipes (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE,
    notes     TEXT NOT NULL DEFAULT '',
    calories  REAL,
    protein_g REAL,
    carbs_g   REAL,
    fat_g     REAL,
    created   TEXT NOT NULL,
    updated   TEXT NOT NULL
);

CREATE TABLE recipe_tags (
    recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (recipe_id, tag)
);

CREATE TABLE recipe_ingredients (
    id         BIGSERIAL PRIMARY KEY,
    recipe_id  TEXT    NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item       TEXT    NOT NULL,
    quantity   REAL,
    unit       TEXT,
    notes      TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE recipe_steps (
    id          BIGSERIAL PRIMARY KEY,
    recipe_id   TEXT    NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    step_num    INTEGER NOT NULL,
    instruction TEXT    NOT NULL
);

CREATE TABLE nutrition_entries (
    id          TEXT  PRIMARY KEY,
    date        TEXT  NOT NULL,
    occurred_at TEXT  NOT NULL,
    name        TEXT  NOT NULL,
    quantity    REAL  NOT NULL DEFAULT 1.0,
    calories    REAL,
    protein_g   REAL,
    carbs_g     REAL,
    fat_g       REAL,
    logged      TEXT  NOT NULL
);

CREATE INDEX nutrition_entries_date_idx ON nutrition_entries(date);

-- Single-user data — RLS not needed
ALTER TABLE lists               DISABLE ROW LEVEL SECURITY;
ALTER TABLE list_items          DISABLE ROW LEVEL SECURITY;
ALTER TABLE reminders           DISABLE ROW LEVEL SECURITY;
ALTER TABLE notes               DISABLE ROW LEVEL SECURITY;
ALTER TABLE health_profile      DISABLE ROW LEVEL SECURITY;
ALTER TABLE weight_log          DISABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition_targets   DISABLE ROW LEVEL SECURITY;
ALTER TABLE workout_sessions    DISABLE ROW LEVEL SECURITY;
ALTER TABLE exercises           DISABLE ROW LEVEL SECURITY;
ALTER TABLE exercise_sets       DISABLE ROW LEVEL SECURITY;
ALTER TABLE recipes             DISABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_tags         DISABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_ingredients  DISABLE ROW LEVEL SECURITY;
ALTER TABLE recipe_steps        DISABLE ROW LEVEL SECURITY;
ALTER TABLE nutrition_entries   DISABLE ROW LEVEL SECURITY;
