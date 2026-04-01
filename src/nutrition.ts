import type Database from 'better-sqlite3';
import { normalizeMacroNutrition, type MacroNutrition, type MacroNutritionInput, ValidationError, uuid } from './helpers.js';
import { getRecipeNutrition } from './recipes.js';

export interface NutritionEntry {
  id: string;
  date: string;
  occurred_at: string;
  name: string;
  quantity: number;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  logged: string;
}

function pad(v: number): string {
  return String(v).padStart(2, '0');
}

function localTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function nowLocal(): string {
  return localTimestamp(new Date());
}

function normalizeOccurredAt(value?: string): string {
  const raw = (value || '').trim();
  if (!raw) return nowLocal();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00`;
  return raw;
}

function dateFromOccurredAt(value: string): string {
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : nowLocal().slice(0, 10);
}

function scaleNutrition(n: MacroNutrition, qty: number): MacroNutrition {
  return {
    calories: Math.round(n.calories * qty * 10) / 10,
    protein_g: Math.round(n.protein_g * qty * 10) / 10,
    carbs_g: Math.round(n.carbs_g * qty * 10) / 10,
    fat_g: Math.round(n.fat_g * qty * 10) / 10,
  };
}

export function logNutrition(db: Database.Database, items: {
  name?: string;
  recipe?: string;
  servings?: number;
  nutrition?: MacroNutritionInput;
  occurred_at?: string;
}[]): NutritionEntry[] {
  const loggedAt = nowLocal();
  const added: NutritionEntry[] = [];

  const insert = db.prepare('INSERT INTO nutrition_entries (id, date, occurred_at, name, quantity, calories, protein_g, carbs_g, fat_g, logged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  db.transaction(() => {
    for (const item of items) {
      const occurredAt = normalizeOccurredAt(item.occurred_at);
      const day = dateFromOccurredAt(occurredAt);
      const servings = item.servings ?? 1.0;
      if (!Number.isFinite(servings) || servings <= 0) {
        throw new ValidationError('Nutrition entries require servings to be greater than 0.');
      }
      let nutr: MacroNutrition;
      let quantity = 1.0;
      let name = (item.name || '').trim();

      if (item.recipe) {
        const rn = getRecipeNutrition(db, item.recipe);
        if (!rn) throw new ValidationError(`Recipe not found: ${item.recipe.trim()}`);
        name = item.recipe.trim();
        quantity = servings;
        nutr = scaleNutrition(rn, servings);
      } else {
        if (!name) throw new ValidationError('Manual nutrition entries require a name.');
        nutr = normalizeMacroNutrition(item.nutrition, `Manual nutrition entry '${name}'`);
      }

      const id = uuid();
      const entry: NutritionEntry = {
        id,
        date: day,
        occurred_at: occurredAt,
        name,
        quantity,
        calories: nutr.calories,
        protein_g: nutr.protein_g,
        carbs_g: nutr.carbs_g,
        fat_g: nutr.fat_g,
        logged: loggedAt,
      };
      insert.run(id, day, occurredAt, entry.name, quantity, entry.calories, entry.protein_g, entry.carbs_g, entry.fat_g, loggedAt);
      added.push(entry);
    }
  })();

  return added;
}

export function getNutrition(db: Database.Database, date?: string): NutritionEntry[] {
  const day = date ? dateFromOccurredAt(normalizeOccurredAt(date)) : nowLocal().slice(0, 10);
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
    '| ID | Food | Qty | Cal | Protein | Carbs | Fat |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const e of entries) {
    const qtyStr = e.quantity !== 1.0 ? `${e.quantity}x` : '';
    lines.push(`| \`${e.id.slice(0, 8)}\` | ${e.name} | ${qtyStr} | ${e.calories ?? '?'} | ${e.protein_g ?? '?'}g | ${e.carbs_g ?? '?'}g | ${e.fat_g ?? '?'}g |`);
    totals.calories += e.calories || 0;
    totals.protein_g += e.protein_g || 0;
    totals.carbs_g += e.carbs_g || 0;
    totals.fat_g += e.fat_g || 0;
  }
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| | **Total** | | **${Math.round(totals.calories)}** | **${Math.round(totals.protein_g)}g** | **${Math.round(totals.carbs_g)}g** | **${Math.round(totals.fat_g)}g** |`);
  return lines.join('\n');
}
