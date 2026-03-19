import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_DB_PATH = path.join(os.homedir(), 'data', 'data.sqlite3');

let _db: Database.Database | null = null;

export function getDb(dbPath?: string): Database.Database {
  if (_db) return _db;
  const p = dbPath || process.env.DATA_DB_PATH || DEFAULT_DB_PATH;
  _db = new Database(p);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  initSchema(_db);
  return _db;
}

export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  initSchema(db);
  return db;
}

function initSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lists (
      name TEXT PRIMARY KEY,
      created TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%S','now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS list_items (
      id TEXT PRIMARY KEY,
      list_name TEXT NOT NULL REFERENCES lists(name),
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_name);

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      due TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      deleted INTEGER NOT NULL DEFAULT 0,
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notes (
      name TEXT PRIMARY KEY,
      content TEXT NOT NULL DEFAULT '',
      updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS health_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      height_in REAL,
      updated TEXT
    );

    CREATE TABLE IF NOT EXISTS weight_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      weight_lbs REAL NOT NULL,
      logged_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nutrition_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      calories REAL NOT NULL,
      protein_g REAL NOT NULL,
      carbs_g REAL NOT NULL,
      fat_g REAL NOT NULL,
      logged_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workout_sessions (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS exercises (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_exercises_session ON exercises(session_id);

    CREATE TABLE IF NOT EXISTS exercise_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exercise_id TEXT NOT NULL REFERENCES exercises(id) ON DELETE CASCADE,
      set_num INTEGER NOT NULL,
      weight_lbs REAL NOT NULL,
      reps INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sets_exercise ON exercise_sets(exercise_id);

    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      notes TEXT NOT NULL DEFAULT '',
      calories REAL,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      created TEXT NOT NULL,
      updated TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recipe_tags (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      tag TEXT NOT NULL,
      PRIMARY KEY (recipe_id, tag)
    );

    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      item TEXT NOT NULL,
      quantity REAL,
      unit TEXT,
      notes TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS recipe_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      step_num INTEGER NOT NULL,
      instruction TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nutrition_entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      name TEXT NOT NULL,
      quantity REAL NOT NULL DEFAULT 1.0,
      calories REAL,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      logged TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_nutrition_date ON nutrition_entries(date);
  `);

  const nutritionColumns = db.prepare('PRAGMA table_info(nutrition_entries)').all() as { name: string }[];
  if (!nutritionColumns.some((column) => column.name === 'occurred_at')) {
    db.exec("ALTER TABLE nutrition_entries ADD COLUMN occurred_at TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE nutrition_entries SET occurred_at = CASE WHEN occurred_at = '' THEN COALESCE(logged, date || 'T00:00:00') ELSE occurred_at END");
  }
}
