import type Database from 'better-sqlite3';
import { now, uuid, today, ensureEasternDate } from './helpers.js';
import { getRecipeNutrition } from './recipes.js';

export interface NutritionEntry {
  id: string;
  date: string;
  name: string;
  quantity: number;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  logged: string;
}

interface NutritionValues {
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}

function scaleNutrition(n: NutritionValues, qty: number): NutritionValues {
  return {
    calories: n.calories != null ? Math.round(n.calories * qty * 10) / 10 : null,
    protein_g: n.protein_g != null ? Math.round(n.protein_g * qty * 10) / 10 : null,
    carbs_g: n.carbs_g != null ? Math.round(n.carbs_g * qty * 10) / 10 : null,
    fat_g: n.fat_g != null ? Math.round(n.fat_g * qty * 10) / 10 : null,
  };
}

export function logNutrition(db: Database.Database, items: {
  name: string;
  quantity?: number;
  recipe?: string;
  nutrition?: NutritionValues;
}[], date?: string): NutritionEntry[] {
  const day = date ? ensureEasternDate(date) : today();
  const n = now();
  const added: NutritionEntry[] = [];

  const insert = db.prepare('INSERT INTO nutrition_entries (id, date, name, quantity, calories, protein_g, carbs_g, fat_g, logged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

  db.transaction(() => {
    for (const item of items) {
      const qty = item.quantity || 1.0;
      let nutr = item.nutrition;

      // Try recipe lookup
      if (item.recipe) {
        const rn = getRecipeNutrition(db, item.recipe);
        if (rn) nutr = scaleNutrition(rn, qty);
      } else if (!nutr) {
        const rn = getRecipeNutrition(db, item.name);
        if (rn) nutr = scaleNutrition(rn, qty);
      }

      // Scale if quantity != 1 and nutrition provided directly (not from recipe)
      if (nutr && qty !== 1.0 && !item.recipe) {
        nutr = scaleNutrition(nutr, qty);
      }

      const id = uuid();
      const entry: NutritionEntry = {
        id, date: day, name: item.name.trim(), quantity: qty,
        calories: nutr?.calories ?? null,
        protein_g: nutr?.protein_g ?? null,
        carbs_g: nutr?.carbs_g ?? null,
        fat_g: nutr?.fat_g ?? null,
        logged: n,
      };
      insert.run(id, day, entry.name, qty, entry.calories, entry.protein_g, entry.carbs_g, entry.fat_g, n);
      added.push(entry);
    }
  })();

  return added;
}

export function getNutrition(db: Database.Database, date?: string): NutritionEntry[] {
  const day = date ? ensureEasternDate(date) : today();
  return db.prepare('SELECT * FROM nutrition_entries WHERE date = ? ORDER BY logged').all(day) as NutritionEntry[];
}

export function deleteNutritionEntry(db: Database.Database, idPrefix: string): NutritionEntry | null {
  // Resolve ID
  let row = db.prepare('SELECT * FROM nutrition_entries WHERE id = ?').get(idPrefix) as NutritionEntry | undefined;
  if (!row) {
    const matches = db.prepare("SELECT * FROM nutrition_entries WHERE id LIKE ? || '%'").all(idPrefix) as NutritionEntry[];
    if (matches.length === 1) row = matches[0];
  }
  if (!row) return null;
  db.prepare('DELETE FROM nutrition_entries WHERE id = ?').run(row.id);
  return row;
}

export function formatNutritionDay(date: string, entries: NutritionEntry[]): string {
  if (!entries.length) return `No nutrition logged for ${date}.`;
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const lines = [
    `**Nutrition log — ${date}**`, '',
    '| Food | Qty | Cal | Protein | Carbs | Fat |',
    '|---|---|---|---|---|---|',
  ];
  for (const e of entries) {
    const qtyStr = e.quantity !== 1.0 ? `${e.quantity}x` : '1x';
    lines.push(`| ${e.name} | ${qtyStr} | ${e.calories ?? '?'} | ${e.protein_g ?? '?'}g | ${e.carbs_g ?? '?'}g | ${e.fat_g ?? '?'}g |`);
    totals.calories += e.calories || 0;
    totals.protein_g += e.protein_g || 0;
    totals.carbs_g += e.carbs_g || 0;
    totals.fat_g += e.fat_g || 0;
  }
  lines.push('|---|---|---|---|---|---|');
  lines.push(`| **Total** | | **${Math.round(totals.calories)}** | **${Math.round(totals.protein_g)}g** | **${Math.round(totals.carbs_g)}g** | **${Math.round(totals.fat_g)}g** |`);
  return lines.join('\n');
}
