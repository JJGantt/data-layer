#!/usr/bin/env node
/**
 * One-time migration: copies all data from the Pi's SQLite database to Supabase.
 *
 * Run on the Pi:
 *   SUPABASE_KEY=<service_role_key> node migrate.mjs [--db /path/to/data.sqlite3]
 *
 * Requires: npm install better-sqlite3 @supabase/supabase-js
 */

import { createClient } from '@supabase/supabase-js';
import Database from 'better-sqlite3';
import path from 'node:path';
import os from 'node:os';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://felyggqjjhltwokdfhop.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_KEY) { console.error('SUPABASE_KEY env var required'); process.exit(1); }

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const DB_PATH = dbIdx >= 0 && args[dbIdx + 1] ? args[dbIdx + 1] : path.join(os.homedir(), 'data', 'data.sqlite3');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const db = new Database(DB_PATH, { readonly: true });

async function upsert(table, rows, onConflict) {
  if (!rows.length) return 0;
  const { error } = await sb.from(table).upsert(rows, onConflict ? { onConflict } : undefined);
  if (error) throw new Error(`${table}: ${error.message}`);
  return rows.length;
}

async function insert(table, rows) {
  if (!rows.length) return 0;
  const { error } = await sb.from(table).insert(rows);
  if (error) throw new Error(`${table}: ${error.message}`);
  return rows.length;
}

async function migrateLists() {
  const lists = db.prepare('SELECT * FROM lists').all();
  const items = db.prepare('SELECT * FROM list_items').all()
    .map(r => ({ ...r, done: !!r.done, deleted: !!r.deleted }));
  console.log(`  lists: ${await upsert('lists', lists, 'name')}, items: ${await upsert('list_items', items, 'id')}`);
}

async function migrateReminders() {
  const rows = db.prepare('SELECT * FROM reminders').all()
    .map(r => ({ ...r, done: !!r.done, deleted: !!r.deleted }));
  console.log(`  reminders: ${await upsert('reminders', rows, 'id')}`);
}

async function migrateNotes() {
  const rows = db.prepare('SELECT * FROM notes').all();
  console.log(`  notes: ${await upsert('notes', rows, 'name')}`);
}

async function migrateHealth() {
  const profile = db.prepare('SELECT * FROM health_profile WHERE id = 1').get();
  if (profile) await upsert('health_profile', [profile], 'id');

  const weights = db.prepare('SELECT * FROM weight_log').all().map(({ id: _, ...r }) => r);
  const targets = db.prepare('SELECT * FROM nutrition_targets').all().map(({ id: _, ...r }) => r);
  await insert('weight_log', weights);
  await insert('nutrition_targets', targets);
  console.log(`  health_profile: ${profile ? 1 : 0}, weight_log: ${weights.length}, nutrition_targets: ${targets.length}`);
}

async function migrateWorkouts() {
  const sessions = db.prepare('SELECT * FROM workout_sessions').all();
  const exercises = db.prepare('SELECT * FROM exercises').all();
  const sets = db.prepare('SELECT * FROM exercise_sets').all().map(({ id: _, ...r }) => r);
  await upsert('workout_sessions', sessions, 'id');
  await upsert('exercises', exercises, 'id');
  await insert('exercise_sets', sets);
  console.log(`  sessions: ${sessions.length}, exercises: ${exercises.length}, sets: ${sets.length}`);
}

async function migrateRecipes() {
  const recipes = db.prepare('SELECT * FROM recipes').all();
  const tags = db.prepare('SELECT * FROM recipe_tags').all();
  const ings = db.prepare('SELECT * FROM recipe_ingredients').all().map(({ id: _, ...r }) => r);
  const steps = db.prepare('SELECT * FROM recipe_steps').all().map(({ id: _, ...r }) => r);
  await upsert('recipes', recipes, 'id');
  if (tags.length) {
    const { error } = await sb.from('recipe_tags').upsert(tags, { onConflict: 'recipe_id,tag' });
    if (error) throw new Error(`recipe_tags: ${error.message}`);
  }
  await insert('recipe_ingredients', ings);
  await insert('recipe_steps', steps);
  console.log(`  recipes: ${recipes.length}, tags: ${tags.length}, ingredients: ${ings.length}, steps: ${steps.length}`);
}

async function migrateNutrition() {
  const entries = db.prepare('SELECT * FROM nutrition_entries').all();
  console.log(`  nutrition_entries: ${await upsert('nutrition_entries', entries, 'id')}`);
}

console.log(`Migrating: ${DB_PATH} → Supabase`);
console.log('Lists...'); await migrateLists();
console.log('Reminders...'); await migrateReminders();
console.log('Notes...'); await migrateNotes();
console.log('Health...'); await migrateHealth();
console.log('Workouts...'); await migrateWorkouts();
console.log('Recipes...'); await migrateRecipes();
console.log('Nutrition...'); await migrateNutrition();
console.log('\nMigration complete.');
