import { getClient } from './client.js';
import { deriveCaloriesFromMacros, now, type MacroNutrition, type MacroNutritionInput, ValidationError, uuid } from './helpers.js';
import { getRecipeNutrition } from './recipes.js';

// How an ingredient counts toward the produce goals. ONE judgment per ingredient; the three
// categories are MUTUALLY EXCLUSIVE. The split is GREENNESS, not leafiness: vitamin K1, lutein and
// folate all track how dark green a vegetable is, and broccoli (102 mcg K1 / 1,400 mcg lutein per
// 100 g) belongs with spinach, not with carrots (13 / 256) or mushrooms (0 / 0). Matches the USDA
// "dark green vegetables" subgroup. The dark-green ⊂ vegetable nesting is a display concern derived
// in produceRollup() — the model never sees it and can never double-count.
export type ProduceType = 'dark_green_vegetable' | 'other_vegetable' | 'fruit';
export const PRODUCE_TYPES: ProduceType[] = ['dark_green_vegetable', 'other_vegetable', 'fruit'];
// Pre-rename values, accepted silently so an in-flight call from a process still holding the old
// tool schema can't fail or land unclassified.
const PRODUCE_TYPE_ALIASES: Record<string, ProduceType> = {
  leafy: 'dark_green_vegetable', leafy_green: 'dark_green_vegetable',
  vegetable: 'other_vegetable', non_leafy_vegetable: 'other_vegetable',
};

export interface NutritionIngredient {
  name: string;
  food?: string; amount?: number | null; unit?: string;
  calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null;
  produce_g?: number; produce_type?: ProduceType;   // absent on non-produce (grains, dairy, meat, oils)
}

// Daily produce totals, rolled up from the ingredients exactly like the macros are.
export interface ProduceRollup { veg_g: number; dark_green_g: number; fruit_g: number; }

export interface NutritionEntry {
  id: string; date: string; occurred_at: string; name: string; quantity: number;
  calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null;
  veg_g?: number | null; dark_green_g?: number | null; fruit_g?: number | null;
  ingredients: NutritionIngredient[] | null; logged: string; staged?: boolean;
  warnings?: string[];   // non-persisted: macro/calorie sanity warnings surfaced back to the caller
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
function round10(v: number): number { return Math.round(v * 10) / 10; }

function fmtAmt(n: number): string { return String(Math.round(n * 1000) / 1000); }

// Human-readable label for one ingredient: structured rows → "1 cup rolled oats" / "0.5 banana";
// legacy rows (name only) → their stored name.
function ingLabel(g: NutritionIngredient): string {
  if (g.food && g.amount != null && isFiniteNumber(g.amount)) {
    const un = (g.unit || '').trim();
    return `${fmtAmt(g.amount)}${un ? ` ${un}` : ''} ${g.food}`;
  }
  return g.name || '—';
}

// A meal's calories legitimately diverge from 4/4/9·macros (fiber ≈ 2 cal/g not 4, sugar alcohols ≈ 0,
// and alcohol is 7 cal/g but not protein/carb/fat at all). So we TRUST stated ingredient calories and
// only SOFT-WARN when they're wildly out of line with the macros — the signature of a bad estimate
// (e.g. milk logged as 190 cal but 6 P / 8 C, which only Atwaters to ~56). Non-blocking; surfaced back.
const CAL_WARN_RATIO = 0.30;   // |stated − atwater| / atwater above this …
const CAL_WARN_ABS = 40;       // … AND at least this many calories apart (don't nag on tiny foods).

// Validate/clean one ingredient. P/C/F are REQUIRED and numeric (they're the source of truth now);
// calories are optional and Atwater-derived per-ingredient when absent. Pushes a soft warning when a
// STATED calorie value is grossly inconsistent with the ingredient's own macros.
function normalizeIngredient(ing: any, context: string, i: number, warnings: string[], requireQuantity = false): NutritionIngredient {
  const food = (ing?.food || '').trim();
  const hasFood = !!food;
  const unit = (ing?.unit || '').trim();
  let amount: number | null = null;
  if (ing?.amount != null) {
    if (!isFiniteNumber(ing.amount)) throw new ValidationError(`${context}: ingredient #${i + 1} has a non-numeric amount.`);
    amount = Math.round(ing.amount * 1000) / 1000;
  }
  // Every logged/staged FOOD must carry a portion: a `food` name + numeric `amount` (unit optional for
  // bare counts like 1 banana). Recipes are exempt (they pass requireQuantity=false). This is the server
  // backstop for "always record the quantity" — the errors are model-facing (estimate the portion; only
  // ask the user when there was no quantity cue at all), never surfaced to the user directly.
  if (requireQuantity) {
    if (!hasFood) throw new ValidationError(`${context}: ingredient #${i + 1} must include a 'food' name and a numeric 'amount' (plus a 'unit' when measured). Estimate a reasonable portion from the user's quantity cue and send structured food/amount/unit — never log a food without a quantity. If there was no quantity indication at all for a food that needs one, ask the user instead of logging.`);
    if (amount == null) throw new ValidationError(`${context}: ingredient '${food}' needs a numeric 'amount' (e.g. 1 cup, 6 oz, 1 serving). Estimate a reasonable portion — do not omit it.`);
  }
  let name = (ing?.name || '').trim();
  if (!name) {
    if (hasFood) name = `${fmtAmt(amount ?? 1)}${unit ? ` ${unit}` : ''} ${food}`;
    else throw new ValidationError(`${context}: ingredient #${i + 1} requires a name.`);
  }
  const reqMacro = (v: unknown, field: string): number => {
    if (!isFiniteNumber(v)) throw new ValidationError(`${context}: ingredient '${name}' requires a numeric ${field}.`);
    if (v < 0) throw new ValidationError(`${context}: ingredient '${name}' has a negative ${field}.`);
    return round10(v);
  };
  const protein_g = reqMacro(ing?.protein_g, 'protein_g');
  const carbs_g = reqMacro(ing?.carbs_g, 'carbs_g');
  const fat_g = reqMacro(ing?.fat_g, 'fat_g');

  const atwater = deriveCaloriesFromMacros(protein_g, carbs_g, fat_g);
  let calories: number;
  if (ing?.calories == null) {
    calories = atwater;                      // no stated calories → fall back to Atwater for THIS ingredient
  } else {
    if (!isFiniteNumber(ing.calories)) throw new ValidationError(`${context}: ingredient '${name}' has a non-numeric calorie value.`);
    if (ing.calories < 0) throw new ValidationError(`${context}: ingredient '${name}' has negative calories.`);
    calories = round10(ing.calories);
    const diff = Math.abs(calories - atwater);
    if (diff >= CAL_WARN_ABS && diff / Math.max(atwater, 1) > CAL_WARN_RATIO) {
      warnings.push(`'${name}': ${calories} cal stated but ${protein_g}P/${carbs_g}C/${fat_g}F only implies ~${atwater} cal — double-check the macros (or it's an alcohol/high-fiber food).`);
    }
  }
  const macros = { calories, protein_g, carbs_g, fat_g };
  const produce = normalizeProduce(ing, name, context);
  return hasFood ? { name, food, amount, unit, ...macros, ...produce } : { name, ...macros, ...produce };
}

// Produce classification for one ingredient. Both fields travel together — a type with no weight (or
// a weight with no type) is a malformed call, not a silent zero, so the model gets told to fix it.
// Non-produce ingredients simply omit both and contribute nothing to the produce totals.
function normalizeProduce(ing: any, name: string, context: string): { produce_g?: number; produce_type?: ProduceType } {
  const rawType = ing?.produce_type;
  const rawGrams = ing?.produce_g;
  const hasType = rawType != null && String(rawType).trim() !== '';
  const hasGrams = rawGrams != null;
  if (!hasType && !hasGrams) return {};

  if (hasType && !hasGrams) throw new ValidationError(`${context}: ingredient '${name}' has produce_type '${rawType}' but no produce_g — give its as-eaten weight in grams.`);
  if (hasGrams && !hasType) throw new ValidationError(`${context}: ingredient '${name}' has produce_g but no produce_type — set it to 'dark_green_vegetable', 'other_vegetable', or 'fruit'.`);

  const raw = String(rawType).trim().toLowerCase();
  const produce_type = (PRODUCE_TYPE_ALIASES[raw] ?? raw) as ProduceType;
  if (!PRODUCE_TYPES.includes(produce_type)) {
    throw new ValidationError(`${context}: ingredient '${name}' has an unknown produce_type '${rawType}'. Use 'dark_green_vegetable' (spinach, kale, arugula, lettuce, chard, broccoli, Brussels sprouts, asparagus, green beans, peas), 'other_vegetable' (mushrooms, onion, cauliflower, carrots, peppers, potato, corn, tomato, beans), or 'fruit' (including avocado).`);
  }
  if (!isFiniteNumber(rawGrams)) throw new ValidationError(`${context}: ingredient '${name}' has a non-numeric produce_g.`);
  if (rawGrams < 0) throw new ValidationError(`${context}: ingredient '${name}' has a negative produce_g.`);
  return { produce_g: round10(rawGrams), produce_type };
}

// Parse the ingredient list (≥1 required) and the warnings raised while validating it.
function normalizeIngredients(raw: unknown, context: string, requireQuantity = false): { ingredients: NutritionIngredient[]; warnings: string[] } {
  if (!Array.isArray(raw) || raw.length === 0) throw new ValidationError(`${context}: at least one ingredient is required.`);
  const warnings: string[] = [];
  const ingredients = raw.map((ing: any, i: number) => normalizeIngredient(ing, context, i, warnings, requireQuantity));
  return { ingredients, warnings };
}

// The entry's totals ARE the sum of its ingredients — every field summed independently. This is the
// single source of truth for calories/protein/carbs/fat; nothing else may set them.
function rollup(ingredients: NutritionIngredient[]): MacroNutrition {
  const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const g of ingredients) {
    t.calories += g.calories ?? 0; t.protein_g += g.protein_g ?? 0;
    t.carbs_g += g.carbs_g ?? 0; t.fat_g += g.fat_g ?? 0;
  }
  return { calories: round10(t.calories), protein_g: round10(t.protein_g), carbs_g: round10(t.carbs_g), fat_g: round10(t.fat_g) };
}

// Produce rollup, same rule: the entry's produce IS the sum of its ingredients'. Dark green vegetables
// count toward BOTH dark_green_g and veg_g — the subset relationship lives here rather than in the
// model's head, so 225 g of broccoli is logged once and lands in both totals.
function produceRollup(ingredients: NutritionIngredient[]): ProduceRollup {
  const t = { veg_g: 0, dark_green_g: 0, fruit_g: 0 };
  for (const g of ingredients) {
    const grams = g.produce_g ?? 0;
    if (!grams || !g.produce_type) continue;
    if (g.produce_type === 'dark_green_vegetable') { t.dark_green_g += grams; t.veg_g += grams; }
    else if (g.produce_type === 'other_vegetable') t.veg_g += grams;
    else if (g.produce_type === 'fruit') t.fruit_g += grams;
  }
  return { veg_g: round10(t.veg_g), dark_green_g: round10(t.dark_green_g), fruit_g: round10(t.fruit_g) };
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
function dateFromOccurredAt(value: string): string {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return now().slice(0, 10);
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => (v === undefined ? 0 : Number(v)));
  const dt = new Date(y, mo - 1, d, h, mi, s);
  dt.setHours(dt.getHours() - EATING_DAY_BOUNDARY_HOUR);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}
function scaleNutrition(n: MacroNutrition, qty: number): MacroNutrition {
  return {
    calories: round10(n.calories * qty),
    protein_g: round10(n.protein_g * qty),
    carbs_g: round10(n.carbs_g * qty),
    fat_g: round10(n.fat_g * qty),
  };
}

// Build the ingredient list for one logged item. EVERY entry is ≥1 ingredient:
//  · explicit `ingredients` (a composite meal) → used as-is
//  · a recipe → one ingredient carrying the recipe's macros × servings
//  · a simple food (top-level `nutrition`, no ingredients) → one name-only ingredient
// The caller then derives the entry totals by summing these ingredients (never the other way around).
async function resolveItemIngredients(item: {
  name?: string; recipe?: string; servings?: number; nutrition?: MacroNutritionInput; ingredients?: NutritionIngredient[] | null;
}, servings: number): Promise<{ name: string; quantity: number; raw: any[]; exempt: boolean }> {
  if (item.recipe) {
    const rn = await getRecipeNutrition(item.recipe);
    if (!rn) throw new ValidationError(`Recipe not found: ${item.recipe.trim()}`);
    const name = item.recipe.trim();
    const scaled = scaleNutrition(rn, servings);
    return { name, quantity: servings, raw: [{ name, ...scaled }], exempt: true };  // recipe: single recipe-macro ingredient, no per-portion amount/unit
  }
  const name = (item.name || '').trim();
  if (!name) throw new ValidationError('Manual nutrition entries require a name.');
  if (Array.isArray(item.ingredients) && item.ingredients.length) {
    return { name, quantity: 1.0, raw: item.ingredients as any[], exempt: false };
  }
  // Simple food: collapse the top-level nutrition into a single name-only ingredient.
  if (item.nutrition == null) throw new ValidationError(`Nutrition entry '${name}' requires either ingredients or nutrition.`);
  return { name, quantity: 1.0, raw: [{ name, ...item.nutrition }], exempt: false };
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

    const { name, quantity, raw, exempt } = await resolveItemIngredients(item, servings);
    const { ingredients, warnings } = normalizeIngredients(raw, `Nutrition entry '${name}'`, !exempt);
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

async function findStaged(idPrefix: string): Promise<NutritionEntry | null> {
  const sb = getClient();
  let { data: row } = await sb.from('nutrition_entries').select('*').eq('id', idPrefix).eq('staged', true).maybeSingle();
  if (!row) {
    const { data: matches } = await sb.from('nutrition_entries').select('*').eq('staged', true).like('id', `${idPrefix}%`);
    if (matches?.length === 1) row = matches[0];
  }
  return (row as NutritionEntry) ?? null;
}

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

// Edit a staged meal's name and/or ingredients. Macros are NEVER set directly — any edit that changes
// the food rebuilds the ingredient list and re-derives the entry totals from it, so parent == sum of
// ingredients always holds. A bare `nutrition` (simple food) is folded into a single name-only ingredient.
export async function editStaged(idPrefix: string, fields: {
  name?: string; nutrition?: MacroNutritionInput; ingredients?: NutritionIngredient[] | null;
}): Promise<NutritionEntry | null> {
  const row = await findStaged(idPrefix);
  if (!row) return null;
  const newName = fields.name != null && fields.name.trim() ? fields.name.trim() : row.name;
  const patch: Record<string, unknown> = {};
  if (newName !== row.name) patch.name = newName;

  // Decide the new ingredient list (if the food is being edited at all).
  let raw: any[] | undefined;
  if (Array.isArray(fields.ingredients) && fields.ingredients.length) raw = fields.ingredients as any[];
  else if (fields.nutrition != null) raw = [{ name: newName, ...fields.nutrition }];

  let warnings: string[] = [];
  if (raw) {
    const out = normalizeIngredients(raw, `Staged meal '${newName}'`, true);
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

export function formatStagedList(entries: NutritionEntry[]): string {
  if (!entries.length) return 'No staged meals.';
  const lines = ['**Staged meals** (not eaten yet — commit to log)', '',
    '| ID | Meal | Cal | Protein | Carbs | Fat |', '|---|---|---|---|---|---|'];
  for (const e of entries)
    lines.push(`| \`${e.id.slice(0, 8)}\` | ${e.name} | ${e.calories ?? '?'} | ${e.protein_g ?? '?'}g | ${e.carbs_g ?? '?'}g | ${e.fat_g ?? '?'}g |`);
  return lines.join('\n');
}

// Grams this ingredient contributes to the dish's cooked weight, or null when it can't be known.
// `unit: 'g'` is the direct case; a produce row carries produce_g (its as-eaten weight) even when the
// portion is a count, which covers "0.5 avocado" and friends. Anything else — 'block', 'cup', 'scoop'
// — is food-specific and NOT derivable from the unit alone, so it returns null and the caller has to
// supply total_g rather than have this silently invent a density.
// Scaled portions want significant figures, not decimal places: a blanket 3dp turns 161 g of broccoli
// into "126.713 g", which reads like a precision nobody has. Grams land whole, small counts keep
// enough resolution to stay distinguishable.
function roundAmount(v: number): number {
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

function ingredientGrams(g: NutritionIngredient): number | null {
  const unit = (g.unit || '').trim().toLowerCase();
  if (unit === 'g' && isFiniteNumber(g.amount)) return Number(g.amount);
  if (isFiniteNumber(g.produce_g) && Number(g.produce_g) > 0) return Number(g.produce_g);
  return null;
}

// Scale a logged dish down by the weight left uneaten.
//
// You cook 432 g of a stir-fry, eat most of it, 92 g goes in the bin — every ingredient should shrink
// by the same fraction, because leftovers are a sample of the whole dish, not of one part of it. So
// this takes the leftover weight, works out the dish's total cooked weight, and scales each
// ingredient's amount AND macros by (total - leftover) / total.
//
// Totals are re-derived from the scaled ingredients by the same rollup every other write uses, so
// parent == sum of ingredients still holds. Display names are rebuilt from the new amounts (dropping
// `name` lets normalizeIngredient regenerate it), so a row never reads "161 g broccoli" while
// carrying the macros for 127 g.
//
// total_g: pass it when the dish contains a portion this can't weigh (tofu by the block, rice by the
// cup). Without it, an unweighable ingredient is an error naming the offenders — better than assuming
// a density and quietly scaling by the wrong factor.
export async function subtractLeftovers(idPrefix: string, grams: number, totalGOverride?: number): Promise<{
  entry: NutritionEntry; total_g: number; eaten_g: number; factor: number; assumedTotal: boolean;
  before: { calories: number | null; protein_g: number | null; carbs_g: number | null; fat_g: number | null };
} | null> {
  if (!isFiniteNumber(grams) || grams <= 0) throw new ValidationError('Leftover grams must be a positive number.');
  const sb = getClient();
  let { data: row } = await sb.from('nutrition_entries').select('*').eq('id', idPrefix).maybeSingle();
  if (!row) {
    const { data: matches } = await sb.from('nutrition_entries').select('*').like('id', `${idPrefix}%`);
    if (matches?.length === 1) row = matches[0];
    else if ((matches?.length ?? 0) > 1) throw new ValidationError(`Ambiguous entry id '${idPrefix}' — ${matches!.length} entries match that prefix.`);
  }
  if (!row) return null;
  const entry = row as NutritionEntry;
  const ings = (entry.ingredients ?? []) as NutritionIngredient[];
  if (!ings.length) throw new ValidationError(`Entry '${entry.name}' has no ingredients to scale.`);

  let total: number;
  if (isFiniteNumber(totalGOverride)) {
    if (Number(totalGOverride) <= 0) throw new ValidationError('total_g must be a positive number.');
    total = Number(totalGOverride);
  } else {
    const unweighable = ings.filter((g) => ingredientGrams(g) == null).map((g) => g.name || g.food || '?');
    if (unweighable.length) {
      throw new ValidationError(
        `Can't weigh ${unweighable.length === 1 ? 'this ingredient' : 'these ingredients'} of '${entry.name}': ${unweighable.join(', ')}. ` +
        'Their portions are not in grams and are not produce, so the total cooked weight is unknown. ' +
        'Estimate the whole dish\'s cooked weight and pass it as total_g.');
    }
    total = ings.reduce((s, g) => s + (ingredientGrams(g) ?? 0), 0);
  }
  if (grams >= total) throw new ValidationError(`Leftover (${grams} g) is not less than the dish's total weight (${round10(total)} g).`);

  const factor = (total - grams) / total;
  const scaled = ings.map((g) => {
    const out: any = { ...g };
    delete out.name;                         // regenerated from the new amount below
    if (isFiniteNumber(g.amount)) out.amount = roundAmount(Number(g.amount) * factor);
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g', 'produce_g'] as const) {
      if (isFiniteNumber((g as any)[k])) out[k] = round10(Number((g as any)[k]) * factor);
    }
    if (!g.food) out.name = g.name;          // legacy row with no structured portion: keep its label
    return out;
  });

  const { ingredients } = normalizeIngredients(scaled, `Entry '${entry.name}'`, false);
  const nutr = rollup(ingredients);
  const prod = produceRollup(ingredients);
  const before = { calories: entry.calories, protein_g: entry.protein_g, carbs_g: entry.carbs_g, fat_g: entry.fat_g };
  const { data } = await sb.from('nutrition_entries').update({
    ingredients, calories: nutr.calories, protein_g: nutr.protein_g, carbs_g: nutr.carbs_g, fat_g: nutr.fat_g,
    veg_g: prod.veg_g, dark_green_g: prod.dark_green_g, fruit_g: prod.fruit_g,
  }).eq('id', entry.id).select().single();

  return { entry: data as NutritionEntry, total_g: round10(total), eaten_g: round10(total - grams),
           factor: Math.round(factor * 1000) / 1000, before, assumedTotal: isFiniteNumber(totalGOverride) };
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
