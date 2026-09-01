// The ingredient — the atom both a logged meal and a saved recipe are built from.
//
// It lives in its own module because BOTH nutrition.ts and recipes.ts need it and nutrition.ts
// already reads recipes (logging a recipe expands it into these), so putting the primitives in
// either one makes a cycle. More importantly it means there is exactly ONE validator: a recipe's
// ingredient is checked, warned about, rolled up and scaled by the same code that does it for a
// meal, so a recipe can never carry a shape the log path would reject.
import { deriveCaloriesFromMacros, ValidationError } from './helpers.js';

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

export interface MacroTotals { calories: number; protein_g: number; carbs_g: number; fat_g: number; }

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
export function round10(v: number): number { return Math.round(v * 10) / 10; }

function fmtAmt(n: number): string { return String(Math.round(n * 1000) / 1000); }

// Human-readable label for one ingredient: structured rows → "1 cup rolled oats" / "0.5 banana";
// legacy rows (name only) → their stored name.
export function ingLabel(g: NutritionIngredient): string {
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
export function normalizeIngredient(ing: any, context: string, i: number, warnings: string[], requireQuantity = false): NutritionIngredient {
  const food = (ing?.food || '').trim();
  const hasFood = !!food;
  const unit = (ing?.unit || '').trim();
  let amount: number | null = null;
  if (ing?.amount != null) {
    if (!isFiniteNumber(ing.amount)) throw new ValidationError(`${context}: ingredient #${i + 1} has a non-numeric amount.`);
    amount = Math.round(ing.amount * 1000) / 1000;
  }
  // Every logged/staged/saved FOOD must carry a portion: a `food` name + numeric `amount` (unit
  // optional for bare counts like 1 banana). This is the server backstop for "always record the
  // quantity" — the errors are model-facing (estimate the portion; only ask the user when there was
  // no quantity cue at all), never surfaced to the user directly.
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
export function normalizeIngredients(raw: unknown, context: string, requireQuantity = false): { ingredients: NutritionIngredient[]; warnings: string[] } {
  if (!Array.isArray(raw) || raw.length === 0) throw new ValidationError(`${context}: at least one ingredient is required.`);
  const warnings: string[] = [];
  const ingredients = raw.map((ing: any, i: number) => normalizeIngredient(ing, context, i, warnings, requireQuantity));
  return { ingredients, warnings };
}

// The totals ARE the sum of the ingredients — every field summed independently. This is the single
// source of truth for calories/protein/carbs/fat on a logged entry AND on a saved recipe; nothing
// else may set them.
export function rollup(ingredients: NutritionIngredient[]): MacroTotals {
  const t = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (const g of ingredients) {
    t.calories += g.calories ?? 0; t.protein_g += g.protein_g ?? 0;
    t.carbs_g += g.carbs_g ?? 0; t.fat_g += g.fat_g ?? 0;
  }
  return { calories: round10(t.calories), protein_g: round10(t.protein_g), carbs_g: round10(t.carbs_g), fat_g: round10(t.fat_g) };
}

// Produce rollup, same rule: the produce IS the sum of the ingredients'. Dark green vegetables count
// toward BOTH dark_green_g and veg_g — the subset relationship lives here rather than in the model's
// head, so 225 g of broccoli is logged once and lands in both totals.
export function produceRollup(ingredients: NutritionIngredient[]): ProduceRollup {
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

// Scaled portions want significant figures, not decimal places: a blanket 3dp turns 161 g of broccoli
// into "126.713 g", which reads like a precision nobody has. Grams land whole, small counts keep
// enough resolution to stay distinguishable.
function roundAmount(v: number): number {
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

// Multiply a whole ingredient list by a factor — every amount, macro and produce weight together.
// Both callers scale a dish uniformly: 2 servings of a recipe, and a dish shrunk by its leftovers.
// Display names are dropped so normalizeIngredient regenerates them from the new amounts, or a row
// would read "161 g broccoli" while carrying the macros for 127 g. Returns RAW objects for
// normalizeIngredients() — the caller re-derives its totals from the result, never scaling those
// separately.
export function scaleIngredients(ingredients: NutritionIngredient[], factor: number): any[] {
  return ingredients.map((g) => {
    const out: any = { ...g };
    delete out.name;                         // regenerated from the new amount below
    if (isFiniteNumber(g.amount)) out.amount = roundAmount(Number(g.amount) * factor);
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g', 'produce_g'] as const) {
      if (isFiniteNumber((g as any)[k])) out[k] = round10(Number((g as any)[k]) * factor);
    }
    if (!g.food) out.name = g.name;          // legacy row with no structured portion: keep its label
    return out;
  });
}

// Grams this ingredient contributes to the dish's cooked weight, or null when it can't be known.
// `unit: 'g'` is the direct case; a produce row carries produce_g (its as-eaten weight) even when the
// portion is a count, which covers "0.5 avocado" and friends. Anything else — 'block', 'cup', 'scoop'
// — is food-specific and NOT derivable from the unit alone, so it returns null and the caller has to
// supply total_g rather than have this silently invent a density.
export function ingredientGrams(g: NutritionIngredient): number | null {
  const unit = (g.unit || '').trim().toLowerCase();
  if (unit === 'g' && isFiniteNumber(g.amount)) return Number(g.amount);
  if (isFiniteNumber(g.produce_g) && Number(g.produce_g) > 0) return Number(g.produce_g);
  return null;
}
