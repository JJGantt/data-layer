#!/usr/bin/env node
/**
 * Migrate existing JSON data files into SQLite.
 *
 * Usage: node dist/migrate.js [--data-dir /path/to/data] [--db /path/to/data.sqlite3]
 *
 * Reads from the JSON files in the data directory and inserts into the SQLite database.
 * Idempotent: skips records that already exist (by primary key).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb } from './db.js';
import type Database from 'better-sqlite3';

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : def;
}

const DATA_DIR = getArg('--data-dir', path.join(os.homedir(), 'data'));
const DB_PATH = getArg('--db', path.join(DATA_DIR, 'data.sqlite3'));

function readJson(filePath: string): any {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function migrateLists(db: Database.Database) {
  const listsDir = path.join(DATA_DIR, 'lists');
  if (!fs.existsSync(listsDir)) return;

  const files = fs.readdirSync(listsDir).filter(f => f.endsWith('.json'));
  let totalItems = 0;

  const insertList = db.prepare('INSERT OR IGNORE INTO lists (name) VALUES (?)');
  const insertItem = db.prepare('INSERT OR IGNORE INTO list_items (id, list_name, text, done, deleted, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)');

  db.transaction(() => {
    for (const file of files) {
      const name = path.basename(file, '.json');
      const data = readJson(path.join(listsDir, file));
      if (!data?.items) continue;

      insertList.run(name);
      for (const item of data.items) {
        insertItem.run(item.id, name, item.text, item.done ? 1 : 0, item.deleted ? 1 : 0, item.created || '', item.updated || '');
        totalItems++;
      }
    }
  })();

  console.log(`  Lists: ${files.length} lists, ${totalItems} items`);
}

function migrateReminders(db: Database.Database) {
  const data = readJson(path.join(DATA_DIR, 'reminders', 'reminders.json'));
  if (!data?.items) { console.log('  Reminders: none found'); return; }

  const insert = db.prepare('INSERT OR IGNORE INTO reminders (id, text, due, done, deleted, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)');

  db.transaction(() => {
    for (const item of data.items) {
      insert.run(item.id, item.text, item.due || null, item.done ? 1 : 0, item.deleted ? 1 : 0, item.created || '', item.updated || '');
    }
  })();

  console.log(`  Reminders: ${data.items.length} items`);
}

function migrateNotes(db: Database.Database) {
  const notesDir = path.join(DATA_DIR, 'notes');
  if (!fs.existsSync(notesDir)) return;

  const files = fs.readdirSync(notesDir).filter(f => f.endsWith('.json'));
  const insert = db.prepare('INSERT OR IGNORE INTO notes (name, content, updated) VALUES (?, ?, ?)');

  db.transaction(() => {
    for (const file of files) {
      const name = path.basename(file, '.json');
      const data = readJson(path.join(notesDir, file));
      if (!data) continue;
      insert.run(name, data.content || '', data.updated || '');
    }
  })();

  console.log(`  Notes: ${files.length} files`);
}

function migrateHealthProfile(db: Database.Database) {
  const data = readJson(path.join(DATA_DIR, 'health', 'profile.json'));
  if (!data) { console.log('  Health profile: none found'); return; }

  if (data.height_in) {
    db.prepare('INSERT OR REPLACE INTO health_profile (id, height_in, updated) VALUES (1, ?, ?)').run(data.height_in, data.updated || '');
  }

  const weightLog = data.weight_log || [];
  const insert = db.prepare('INSERT INTO weight_log (date, weight_lbs, logged_at) VALUES (?, ?, ?)');
  db.transaction(() => {
    for (const entry of weightLog) {
      insert.run(entry.date, entry.weight_lbs, entry.logged_at || '');
    }
  })();

  console.log(`  Health profile: height=${data.height_in || 'none'}, ${weightLog.length} weight entries`);
}

function migrateWorkouts(db: Database.Database) {
  const data = readJson(path.join(DATA_DIR, 'health', 'workouts.json'));
  if (!data?.sessions) { console.log('  Workouts: none found'); return; }

  const insertSession = db.prepare('INSERT OR IGNORE INTO workout_sessions (id, date, type, notes) VALUES (?, ?, ?, ?)');
  const insertExercise = db.prepare('INSERT OR IGNORE INTO exercises (id, session_id, name, sort_order) VALUES (?, ?, ?, ?)');
  const insertSet = db.prepare('INSERT INTO exercise_sets (exercise_id, set_num, weight_lbs, reps) VALUES (?, ?, ?, ?)');

  let totalExercises = 0;
  let totalSets = 0;

  db.transaction(() => {
    for (const session of data.sessions) {
      insertSession.run(session.id, session.date, session.type, session.notes || '');
      for (let i = 0; i < (session.exercises || []).length; i++) {
        const ex = session.exercises[i];
        insertExercise.run(ex.id, session.id, ex.name, i);
        totalExercises++;
        for (const set of ex.sets || []) {
          insertSet.run(ex.id, set.set_num, set.weight_lbs, set.reps);
          totalSets++;
        }
      }
    }
  })();

  console.log(`  Workouts: ${data.sessions.length} sessions, ${totalExercises} exercises, ${totalSets} sets`);
}

function migrateRecipes(db: Database.Database) {
  const data = readJson(path.join(DATA_DIR, 'recipes', 'recipes.json'));
  if (!data?.recipes) { console.log('  Recipes: none found'); return; }

  const insertRecipe = db.prepare('INSERT OR IGNORE INTO recipes (id, name, notes, calories, protein_g, carbs_g, fat_g, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertTag = db.prepare('INSERT OR IGNORE INTO recipe_tags (recipe_id, tag) VALUES (?, ?)');
  const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, item, quantity, unit, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  const insertStep = db.prepare('INSERT INTO recipe_steps (recipe_id, step_num, instruction) VALUES (?, ?, ?)');

  db.transaction(() => {
    for (const r of data.recipes) {
      const n = r.nutrition || {};
      insertRecipe.run(r.id, r.name, r.notes || '', n.calories ?? null, n.protein_g ?? null, n.carbs_g ?? null, n.fat_g ?? null, r.created || '', r.updated || '');

      for (const tag of r.tags || []) {
        insertTag.run(r.id, tag);
      }
      for (let i = 0; i < (r.ingredients || []).length; i++) {
        const ing = r.ingredients[i];
        insertIng.run(r.id, ing.item, ing.quantity ?? null, ing.unit ?? null, ing.notes ?? null, i);
      }
      for (let i = 0; i < (r.steps || []).length; i++) {
        insertStep.run(r.id, i + 1, r.steps[i]);
      }
    }
  })();

  console.log(`  Recipes: ${data.recipes.length}`);
}

function migrateNutrition(db: Database.Database) {
  const data = readJson(path.join(DATA_DIR, 'nutrition', 'log.json'));
  if (!data?.entries) { console.log('  Nutrition: none found'); return; }

  const insert = db.prepare('INSERT OR IGNORE INTO nutrition_entries (id, date, name, quantity, calories, protein_g, carbs_g, fat_g, logged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  db.transaction(() => {
    for (const e of data.entries) {
      const n = e.nutrition || {};
      insert.run(e.id, e.date, e.name, e.quantity || 1.0, n.calories ?? null, n.protein_g ?? null, n.carbs_g ?? null, n.fat_g ?? null, e.logged || '');
    }
  })();

  console.log(`  Nutrition: ${data.entries.length} entries`);
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log(`Migrating data from ${DATA_DIR} to ${DB_PATH}`);
const db = openDb(DB_PATH);

migrateLists(db);
migrateReminders(db);
migrateNotes(db);
migrateHealthProfile(db);
migrateWorkouts(db);
migrateRecipes(db);
migrateNutrition(db);

console.log('\nMigration complete.');
db.close();
