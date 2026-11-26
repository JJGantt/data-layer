import { getClient } from './client.js';
import { now, type MacroNutritionInput, ValidationError, uuid } from './helpers.js';
import { getRecipe, saveRecipe, type Recipe } from './recipes.js';
import {
  ingLabel, ingredientGrams, isFiniteNumber, normalizeIngredients, produceRollup, rollup,
  round10, scaleIngredients, type NutritionIngredient, type ProduceRollup,
} from './ingredients.js';

export type { NutritionIngredient, ProduceRollup, ProduceType } from './ingredients.js';
export { PRODUCE_TYPES } from './ingredients.js';

export interface NutritionEntry {
  id: string; date: string; occurred_at: string; name: string; quantity: number;
  calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null;
  veg_g?: number | null; dark_green_g?: number | null; fruit_g?: number | null;
  ingredients: NutritionIngredient[] | null; logged: string; staged?: boolean;
  warnings?: string[];   // non-persisted: macro/calorie sanity warnings surfaced back to the caller
}

function pad(v: number): string { return String(v).padStart(2, '0'); }
function normalizeOccurredAt(value?: string): string {
  const raw = (value || '').trim();
  if (!raw) return now();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T12:00:00`;
  return raw;
}
// The "eating day" boundary: anything before 4 a.m. local counts toward the
// previous day, so late-night snacks roll into the day you were actually awake
// for rather than starting a fresh day at midnight.
const EATING_DAY_BOUNDARY_HOUR = 4;
export function dateFromOccurredAt(value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return now().slice(0, 10);
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const dt = new Date(y, mo - 1, d, h, mi, s);
  dt.setHours(dt.getHours() - EATING_DAY_BOUNDARY_HOUR);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
// Build the ingredient list for one logged item. EVERY entry is ≥1 ingredient:
//  · explicit `ingredients` (a composite meal) → used as-is
//  · a recipe → the recipe's OWN ingredients, every amount and macro scaled by servings
//  · a simple food (top-level `nutrition`, no ingredients) → one name-only ingredient
// The caller then derives the entry totals by summing these ingredients (never the other way around).
//
// A recipe expands rather than collapsing into one lump row carrying its totals, which is what it used
// to do. That lump had no per-ingredient portions, so a recipe logged by name contributed nothing to
// the produce goals (85 g of banana in the overnight oats counted as zero fruit) and could not be
// scaled by subtract_leftovers. Expanding makes a recipe log identically to typing the meal out.
async function resolveItemIngredients(item: {
  name?: string; recipe?: string; servings?: number; nutrition?: MacroNutritionInput; ingredients?: NutritionIngredient[] | null;
}, servings: number): Promise<{ name: string; quantity: number; raw: any[] }> {
  if (item.recipe) {
    const recipe = await getRecipe(item.recipe);
    if (!recipe) throw new ValidationError(`Recipe not found: ${item.recipe.trim()}`);
    return { name: recipe.name, quantity: servings, raw: scaleIngredients(recipe.ingredients, servings) };
  }
  const name = (item.name || '').trim();
  if (!name) throw new ValidationError('Manual nutrition entries require a name.');
  if (Array.isArray(item.ingredients) && item.ingredients.length) {
    return { name, quantity: 1.0, raw: item.ingredients as any[] };
  }
  // Simple food: collapse the top-level nutrition into a single name-only ingredient.
  if (item.nutrition == null) throw new ValidationError(`Nutrition entry '${name}' requires either ingredients or nutrition.`);
  return { name, quantity: 1.0, raw: [{ name, ...item.nutrition }] };
}

export async function logNutrition(items: {
  name?: string; recipe?: string; servings?: number;
  nutrition?: MacroNutritionInput; occurred_at?: string;
  ingredients?: NutritionIngredient[] | null;
}[], opts?: { staged?: boolean }): Promise<NutritionEntry[]> {
  const staged = opts?.staged ?? false;
  const loggedAt = now();
  const added: NutritionEntry[] = [];
  const sb = getClient();

  for (const item of items) {
    const occurredAt = normalizeOccurredAt(item.occurred_at);
    const day = dateFromOccurredAt(occurredAt);
    const servings = item.servings ?? 1.0;
    if (!Number.isFinite(servings) || servings <= 0) throw new ValidationError('Nutrition entries require servings to be greater than 0.');

    const { name, quantity, raw } = await resolveItemIngredients(item, servings);
    const { ingredients, warnings } = normalizeIngredients(raw, `Nutrition entry '${name}'`, true);
    const nutr = rollup(ingredients);   // totals = sum of ingredients, always
    const prod = produceRollup(ingredients);

    const id = uuid();
    const entry: NutritionEntry = { id, date: day, occurred_at: occurredAt, name, quantity, calories: nutr.calories, protein_g: nutr.protein_g, carbs_g: nutr.carbs_g, fat_g: nutr.fat_g, ...prod, ingredients, logged: loggedAt, staged };
    const { data } = await sb.from('nutrition_entries').insert(entry).select().single();
    const saved = data as NutritionEntry;
    if (warnings.length) saved.warnings = warnings;
    added.push(saved);
  }
  return added;
}

// getNutrition returns only COMMITTED (eaten) entries — staged meals are never counted as eaten.
export async function getNutrition(date?: string): Promise<NutritionEntry[]> {
  const day = date ? dateFromOccurredAt(normalizeOccurredAt(date)) : dateFromOccurredAt(now());
  const { data } = await getClient().from('nutrition_entries').select('*').eq('date', day).eq('staged', false).order('logged');
  return (data ?? []) as NutritionEntry[];
}

// ---- staged meals ---------------------------------------------------------
// A staged meal you might eat / will eat later. Lives in nutrition_entries with staged=true, never
// counted in totals, and surfaced in the CURRENT day regardless of when it was staged. It only
// leaves the table when COMMITTED (→ a real entry stamped at commit time) or manually removed.

export async function stageNutrition(items: Parameters<typeof logNutrition>[0]): Promise<NutritionEntry[]> {
  return logNutrition(items, { staged: true });
}

// All staged meals (any day) — they all float into the current day's view.
export async function getStaged(): Promise<NutritionEntry[]> {
  const { data } = await getClient().from('nutrition_entries').select('*').eq('staged', true).order('logged');
  return (data ?? []) as NutritionEntry[];
}

// Every by-id operation takes an 8-char prefix as readily as a full id, because that is what the
// day table prints. `staged` narrows the search to (or away from) staged meals when the caller only
// means one kind; omitted, it searches both.
export async function findEntry(idPrefix: string, staged?: boolean): Promise<NutritionEntry | null> {
  const sb = getClient();
  const scoped = () => {
    const q = sb.from('nutrition_entries').select('*');
    return staged === undefined ? q : q.eq('staged', staged);
  };
  let { data: row } = await scoped().eq('id', idPrefix).maybeSingle();
  if (!row) {
    const { data: matches } = await scoped().like('id', `${idPrefix}%`);
    if (matches?.length === 1) row = matches[0];
    else if ((matches?.length ?? 0) > 1) throw new ValidationError(`Ambiguous entry id '${idPrefix}' — ${matches!.length} entries match that prefix.`);
  }
  return (row as NutritionEntry) ?? null;
}

const findStaged = (idPrefix: string) => findEntry(idPrefix, true);

// Commit a staged meal: flip staged→false and re-stamp the time to NOW (the moment you eat it), so
// it lands as a normal entry on the current day and starts counting.
export async function commitStaged(idPrefix: string): Promise<NutritionEntry | null> {
  const row = await findStaged(idPrefix);
  if (!row) return null;
  const occurredAt = now();
  const { data } = await getClient().from('nutrition_entries')
    .update({ staged: false, occurred_at: occurredAt, date: dateFromOccurredAt(occurredAt), logged: occurredAt })
    .eq('id', row.id).select().single();
  return data as NutritionEntry;
}

// Edit a meal's name and/or ingredients — staged or already logged, one implementation. Macros are
// NEVER set directly — any edit that changes the food rebuilds the ingredient list and re-derives the
// entry totals from it, so parent == sum of ingredients always holds. A bare `nutrition` (simple food)
// is folded into a single name-only ingredient. `occurred_at` moves a LOGGED entry to another time (and
// its eating day with it); a staged meal has no meaningful time, since committing restamps it.
export async function editEntry(idPrefix: string, staged: boolean, fields: {
  name?: string; nutrition?: MacroNutritionInput; ingredients?: NutritionIngredient[] | null; occurred_at?: string;
}): Promise<NutritionEntry | null> {
  const row = await findEntry(idPrefix, staged);
  if (!row) return null;
  const newName = fields.name != null && fields.name.trim() ? fields.name.trim() : row.name;
  const patch: Record<string, unknown> = {};
  if (newName !== row.name) patch.name = newName;
  if (!staged && fields.occurred_at != null && fields.occurred_at.trim()) {
    const occurredAt = normalizeOccurredAt(fields.occurred_at);
    patch.occurred_at = occurredAt;
    patch.date = dateFromOccurredAt(occurredAt);
  }

  // Decide the new ingredient list (if the food is being edited at all).
  let raw: any[] | undefined;
  if (Array.isArray(fields.ingredients) && fields.ingredients.length) raw = fields.ingredients as any[];
  else if (fields.nutrition != null) raw = [{ name: newName, ...fields.nutrition }];

  let warnings: string[] = [];
  if (raw) {
    const out = normalizeIngredients(raw, `${staged ? 'Staged meal' : 'Nutrition entry'} '${newName}'`, true);
    const nutr = rollup(out.ingredients);
    const prod = produceRollup(out.ingredients);
    patch.ingredients = out.ingredients;
    patch.calories = nutr.calories; patch.protein_g = nutr.protein_g; patch.carbs_g = nutr.carbs_g; patch.fat_g = nutr.fat_g;
    patch.veg_g = prod.veg_g; patch.dark_green_g = prod.dark_green_g; patch.fruit_g = prod.fruit_g;
    warnings = out.warnings;
  }
  if (Object.keys(patch).length === 0) return row;
  const { data } = await getClient().from('nutrition_entries').update(patch).eq('id', row.id).select().single();
  const saved = data as NutritionEntry;
  if (warnings.length) saved.warnings = warnings;
  return saved;
}

export async function removeStaged(idPrefix: string): Promise<NutritionEntry | null> {
  const row = await findStaged(idPrefix);
  if (!row) return null;
  await getClient().from('nutrition_entries').delete().eq('id', row.id);
  return row;
}

/**
 * The confirmation a food write returns: only the entries it touched, with their macros and ids.
 * Never the whole day's log — the hub already shows it, and a model handed the day's table recites it
 * after every bite logged.
 */
export function formatEntryConfirmation(verb: string, entries: NutritionEntry[]): string {
  const lines = entries.map((e) => {
    const qty = e.quantity !== 1 ? ` (${e.quantity}x)` : '';
    return `${verb} ${e.name}${qty} — ${e.calories ?? '?'} cal · P ${e.protein_g ?? '?'}g · C ${e.carbs_g ?? '?'}g · F ${e.fat_g ?? '?'}g (id \`${e.id.slice(0, 8)}\`)`;
  });
  lines.push('', "Reply with a one-line confirmation of this only. Do not list the day's log or totals: the hub shows them.");
  return lines.join('\n');
}

export function formatStagedList(entries: NutritionEntry[]): string {
  if (!entries.length) return 'No staged meals.';
  const lines = ['**Staged meals** (not eaten yet — commit to log)', '',
    '| ID | Meal | Cal | Protein | Carbs | Fat |', '|---|---|---|---|---|---|'];
  for (const e of entries)
    lines.push(`| \`${e.id.slice(0, 8)}\` | ${e.name} | ${e.calories ?? '?'} | ${e.protein_g ?? '?'}g | ${e.carbs_g ?? '?'}g | ${e.fat_g ?? '?'}g |`);
  return lines.join('\n');
}

// The arithmetic of a leftover subtraction, apart from the read and the write: the dish's weight, the
// fraction eaten, and the ingredients and totals scaled by it.
export function planLeftovers(ings: NutritionIngredient[], grams: number, totalGOverride: number | undefined, dishName: string) {
  if (!isFiniteNumber(grams) || grams <= 0) throw new ValidationError('Leftover grams must be a positive number.');
  if (!ings.length) throw new ValidationError(`Entry '${dishName}' has no ingredients to scale.`);
  let total: number;
  if (isFiniteNumber(totalGOverride)) {
    if (Number(totalGOverride) <= 0) throw new ValidationError('total_g must be a positive number.');
    total = Number(totalGOverride);
  } else {
    const unweighable = ings.filter((g) => ingredientGrams(g) == null).map((g) => g.name || g.food || '?');
    if (unweighable.length) {
      throw new ValidationError(
        `Can't weigh ${unweighable.length === 1 ? 'this ingredient' : 'these ingredients'} of '${dishName}': ${unweighable.join(', ')}. ` +
        'Their portions are not in grams and are not produce, so the total cooked weight is unknown. ' +
        'Estimate the whole dish\'s cooked weight and pass it as total_g.');
    }
    total = ings.reduce((s, g) => s + (ingredientGrams(g) ?? 0), 0);
  }
  if (grams >= total) throw new ValidationError(`Leftover (${grams} g) is not less than the dish's total weight (${round10(total)} g).`);

  const factor = (total - grams) / total;
  const { ingredients } = normalizeIngredients(scaleIngredients(ings, factor), `Entry '${dishName}'`, false);
  return { ingredients, nutr: rollup(ingredients), prod: produceRollup(ingredients), total, factor };
}

// Scale a logged dish down by the weight left uneaten.
//
// You cook 432 g of a stir-fry, eat most of it, 92 g goes in the bin — every ingredient should shrink
// by the same fraction, because leftovers are a sample of the whole dish, not of one part of it. So
// this takes the leftover weight, works out the dish's total cooked weight, and scales each
// ingredient's amount AND macros by (total - leftover) / total.
//
// Totals are re-derived from the scaled ingredients by the same rollup every other write uses, so
// parent == sum of ingredients still holds.
//
// total_g: pass it when the dish contains a portion this can't weigh (tofu by the block, rice by the
// cup). Without it, an unweighable ingredient is an error naming the offenders — better than assuming
// a density and quietly scaling by the wrong factor.
export async function subtractLeftovers(idPrefix: string, grams: number, totalGOverride?: number): Promise<{
  entry: NutritionEntry; total_g: number; eaten_g: number; factor: number; assumedTotal: boolean;
  before: { calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null };
} | null> {
  const sb = getClient();
  const entry = await findEntry(idPrefix);
  if (!entry) return null;
  const ings = (entry.ingredients ?? []) as NutritionIngredient[];
  const { ingredients, nutr, prod, total, factor } = planLeftovers(ings, grams, totalGOverride, entry.name);
  const before = { calories: entry.calories, protein_g: entry.protein_g, carbs_g: entry.carbs_g, fat_g: entry.fat_g };
  const { data } = await sb.from('nutrition_entries').update({
    ingredients, calories: nutr.calories, protein_g: nutr.protein_g, carbs_g: nutr.carbs_g, fat_g: nutr.fat_g,
    veg_g: prod.veg_g, dark_green_g: prod.dark_green_g, fruit_g: prod.fruit_g,
  }).eq('id', entry.id).select().single();

  return { entry: data as NutritionEntry, total_g: round10(total), eaten_g: round10(total - grams),
           factor: Math.round(factor * 1000) / 1000, before, assumedTotal: isFiniteNumber(totalGOverride) };
}

export async function deleteNutritionEntry(idPrefix: string): Promise<NutritionEntry | null> {
  const entry = await findEntry(idPrefix);
  if (!entry) return null;
  await getClient().from('nutrition_entries').delete().eq('id', entry.id);
  return entry;
}

// "Save that as a recipe" — the meal you just logged, kept for next time. It goes through
// saveRecipe() like any other save, so the recipe lands validated and its totals re-derived; the
// entry's ingredients already carry portions, macros and produce, which is exactly what a recipe
// needs and why this is a copy rather than a re-description.
//
// It lives here rather than in recipes.ts because a nutrition entry is nutrition's to read, and
// nutrition already depends on recipes (logging one expands it). The other direction would be a cycle.
export async function saveEntryAsRecipe(idPrefix: string, opts?: {
  name?: string; steps?: string[]; notes?: string; tags?: string[];
}): Promise<{ recipe: Recipe; action: string; warnings: string[]; from: NutritionEntry } | null> {
  const entry = await findEntry(idPrefix);
  if (!entry) return null;
  const ings = entry.ingredients ?? [];
  if (!ings.length) throw new ValidationError(`Entry '${entry.name}' has no ingredients to save as a recipe.`);
  const saved = await saveRecipe({
    name: (opts?.name || '').trim() || entry.name,
    ingredients: ings, steps: opts?.steps, notes: opts?.notes, tags: opts?.tags,
  });
  return { ...saved, from: entry };
}

export function formatNutritionDay(date: string, entries: NutritionEntry[]): string {
  if (!entries.length) return `No nutrition logged for ${date}.`;
  const totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  const produce = { veg_g: 0, dark_green_g: 0, fruit_g: 0 };
  const lines = [
    `**Nutrition log — ${date}**`, '',
    '| ID | Food | Qty | Cal | Protein | Carbs | Fat |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const e of entries) {
    const qtyStr = e.quantity !== 1.0 ? `${e.quantity}x` : '';
    lines.push(`| \`${e.id.slice(0, 8)}\` | ${e.name} | ${qtyStr} | ${e.calories ?? '?'} | ${e.protein_g ?? '?'}g | ${e.carbs_g ?? '?'}g | ${e.fat_g ?? '?'}g |`);
    // Composite meals (>1 ingredient): render each component as an indented sub-row so callers see the
    // structured breakdown. A single-ingredient entry IS its own breakdown, so it renders flat (no sub-row).
    // Sub-rows are NOT added to the day totals — the entry row already carries the summed macros.
    if (Array.isArray(e.ingredients) && e.ingredients.length > 1) {
      for (const g of e.ingredients) {
        lines.push(`| | ↳ ${ingLabel(g)} | | ${g.calories ?? '?'} | ${g.protein_g ?? '?'}g | ${g.carbs_g ?? '?'}g | ${g.fat_g ?? '?'}g |`);
      }
    }
    totals.calories += e.calories || 0; totals.protein_g += e.protein_g || 0;
    totals.carbs_g += e.carbs_g || 0; totals.fat_g += e.fat_g || 0;
    produce.veg_g += e.veg_g || 0; produce.dark_green_g += e.dark_green_g || 0; produce.fruit_g += e.fruit_g || 0;
  }
  lines.push('|---|---|---|---|---|---|---|');
  lines.push(`| | **Total** | | **${Math.round(totals.calories)}** | **${Math.round(totals.protein_g)}g** | **${Math.round(totals.carbs_g)}g** | **${Math.round(totals.fat_g)}g** |`);
  // Produce goes on its own line rather than as three more table columns — the macro table is already
  // wide, and produce is a separate goal set (fill-to-target, not paced). Leafy is shown nested to
  // make the subset relationship visible: veg_g ALREADY includes it.
  if (produce.veg_g || produce.fruit_g) {
    lines.push('');
    lines.push(`**Produce** — vegetables ${Math.round(produce.veg_g)}g (of which dark green ${Math.round(produce.dark_green_g)}g) · fruit ${Math.round(produce.fruit_g)}g`);
  }
  return lines.join('\n');
}
