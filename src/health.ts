import type Database from 'better-sqlite3';
import { now, today } from './helpers.js';

export interface WeightEntry {
  id: number;
  date: string;
  weight_lbs: number;
  logged_at: string;
}

export interface NutritionTargetEntry {
  id: number;
  date: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  logged_at: string;
}

export function getProfile(db: Database.Database): { height_in: number | null; updated: string | null } {
  const row = db.prepare('SELECT height_in, updated FROM health_profile WHERE id = 1').get() as any;
  return row || { height_in: null, updated: null };
}

export function setHeight(db: Database.Database, heightIn: number): void {
  const n = now();
  db.prepare(`
    INSERT INTO health_profile (id, height_in, updated) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET height_in = excluded.height_in, updated = excluded.updated
  `).run(heightIn, n);
}

export function logWeight(db: Database.Database, weightLbs: number, date?: string): WeightEntry {
  const d = date || today();
  const n = now();
  const result = db.prepare('INSERT INTO weight_log (date, weight_lbs, logged_at) VALUES (?, ?, ?)').run(d, weightLbs, n);
  return { id: result.lastInsertRowid as number, date: d, weight_lbs: weightLbs, logged_at: n };
}

export function recentWeights(db: Database.Database, limit = 5): WeightEntry[] {
  return db.prepare('SELECT * FROM weight_log ORDER BY date DESC, id DESC LIMIT ?').all(limit) as WeightEntry[];
}

export function setNutritionTargets(db: Database.Database, targets: { calories: number; protein_g: number; carbs_g: number; fat_g: number }, date?: string): NutritionTargetEntry {
  const d = date || today();
  const n = now();
  const result = db.prepare('INSERT INTO nutrition_targets (date, calories, protein_g, carbs_g, fat_g, logged_at) VALUES (?, ?, ?, ?, ?, ?)').run(d, targets.calories, targets.protein_g, targets.carbs_g, targets.fat_g, n);
  return { id: result.lastInsertRowid as number, date: d, ...targets, logged_at: n };
}

export function recentTargets(db: Database.Database, limit = 3): NutritionTargetEntry[] {
  return db.prepare('SELECT * FROM nutrition_targets ORDER BY date DESC, id DESC LIMIT ?').all(limit) as NutritionTargetEntry[];
}

export function formatProfile(profile: { height_in: number | null }, weights: WeightEntry[], targets: NutritionTargetEntry[] = []): string {
  const lines: string[] = [];
  if (profile.height_in) {
    const feet = Math.floor(profile.height_in / 12);
    const inches = Math.floor(profile.height_in % 12);
    lines.push(`Height: ${profile.height_in} in (${feet}'${inches}")`);
  } else {
    lines.push('Height: not set');
  }
  if (weights.length) {
    lines.push(`Latest weight: ${weights[0].weight_lbs} lbs on ${weights[0].date}`);
    lines.push(`\nWeight log (last ${weights.length}):`);
    for (const e of weights) {
      lines.push(`  ${e.date}: ${e.weight_lbs} lbs`);
    }
  } else {
    lines.push('Weight log: empty');
  }
  if (targets.length) {
    const t = targets[0];
    lines.push(`\nNutrition targets (as of ${t.date}): ${t.calories} cal, ${t.protein_g}g protein, ${t.carbs_g}g carbs, ${t.fat_g}g fat`);
    if (targets.length > 1) {
      lines.push(`\nTarget history (last ${targets.length}):`);
      for (const e of targets) {
        lines.push(`  ${e.date}: ${e.calories} cal, ${e.protein_g}g P / ${e.carbs_g}g C / ${e.fat_g}g F`);
      }
    }
  } else {
    lines.push('\nNutrition targets: not set');
  }
  return lines.join('\n');
}
