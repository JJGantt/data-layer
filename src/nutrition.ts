import { getClient } from './client.js';
import { normalizeMacroNutrition, type MacroNutrition, type MacroNutritionInput, ValidationError, uuid } from './helpers.js';
import { getRecipeNutrition } from './recipes.js';

export interface NutritionEntry {
  id: string; date: string; occurred_at: string; name: string; quantity: number;
  calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null; logged: string;
}

function pad(v: number): string { return String(v).padStart(2, '0'); }
function localTimestamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function nowLocal(): string { return localTimestamp(new Date()); }
function normalizeOccurredAt(value?: string): string {
  const raw = (value || '').trim();
  if (!raw) return nowLocal();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T12:00:00`;
  return raw;
}
// The "eating day" boundary: anything before 4 a.m. local counts toward the
// previous day, so late-night snacks roll into the day you were actually awake
// for rather than starting a fresh day at midnight.
const EATING_DAY_BOUNDARY_HOUR = 4;
function dateFromOccurredAt(value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return nowLocal().slice(0, 10);
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const dt = new Date(y, mo - 1, d, h, mi, s);
  dt.setHours(dt.getHours() - EATING_DAY_BOUNDARY_HOUR);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function scaleNutrition(n: MacroNutrition, qty: number): MacroNutrition {
  return {
    calories: Math.round(n.calories * qty * 10) / 10,
    protein_g: Math.round(n.protein_g * qty * 10) / 10,
    carbs_g: Math.round(n.carbs_g * qty * 10) / 10,
    fat_g: Math.round(n.fat_g * qty * 10) / 10,
  };
}

export async function logNutrition(items: {
  name?: string; recipe?: string; servings?: number;
  nutrition?: MacroNutritionInput; occurred_at?: string;
}[]): Promise<NutritionEntry[]> {
  const loggedAt = nowLocal();
  const added: NutritionEntry[] = [];
  const sb = getClient();

  for (const item of items) {
    const occurredAt = normalizeOccurredAt(item.occurred_at);
    const day = dateFromOccurredAt(occurredAt);
    const servings = item.servings ?? 1.0;
    if (!Number.isFinite(servings) || servings <= 0) throw new ValidationError('Nutrition entries require servings to be greater than 0.');
    let nutr: MacroNutrition;
    let quantity = 1.0;
    let name = (item.name || '').trim();

    if (item.recipe) {
      const rn = await getRecipeNutrition(item.recipe);
      if (!rn) throw new ValidationError(`Recipe not found: ${item.recipe.trim()}`);
      name = item.recipe.trim();
      quantity = servings;
      nutr = scaleNutrition(rn, servings);
    } else {
      if (!name) throw new ValidationError('Manual nutrition entries require a name.');
      nutr = normalizeMacroNutrition(item.nutrition, `Manual nutrition entry '${name}'`);
    }

    const id = uuid();
    const entry: NutritionEntry = { id, date: day, occurred_at: occurredAt, name, quantity, calories: nutr.calories, protein_g: nutr.protein_g, carbs_g: nutr.carbs_g, fat_g: nutr.fat_g, logged: loggedAt };
    const { data } = await sb.from('nutrition_entries').insert(entry).select().single();
    added.push(data as NutritionEntry);
  }
  return added;
}

export async function getNutrition(date?: string): Promise<NutritionEntry[]> {
  const day = date ? dateFromOccurredAt(normalizeOccurredAt(date)) : dateFromOccurredAt(nowLocal());
  const { data } = await getClient().from('nutrition_entries').select('*').eq('date', day).order('logged');
  return (data ?? []) as NutritionEntry[];
}

export async function deleteNutritionEntry(idPrefix: string): Promise<NutritionEntry | null> {
  const sb = getClient();
  let { data: row } = await sb.from('nutrition_entries').select('*').eq('id', idPrefix).maybeSingle();
  if (!row) {
    const { data: matches } = await sb.from('nutrition_entries').select('*').like('id', `${idPrefix}%`);
    if (matches?.length === 1) row = matches[0];
  }
  if (!row) return null;
  await sb.from('nutrition_entries').delete().eq('id', row.id);
  return row as NutritionEntry;
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
    totals.calories += e.calories || 0; totals.protein_g += e.protein_g || 0;
    totals.carbs_g += e.carbs_g || 0; totals.fat_g += e.fat_g || 0;
  }
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| | **Total** | | **${Math.round(totals.calories)}** | **${Math.round(totals.protein_g)}g** | **${Math.round(totals.carbs_g)}g** | **${Math.round(totals.fat_g)}g** |`);
  return lines.join('\n');
}
