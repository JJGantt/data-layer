// The pantry: the specific products he keeps at home, with their label nutrition (00195).
//
// What it is for: "yum yum sauce" said at home means the bottle on his shelf, so the logger passes that
// row's `pantry_id` on the ingredient and the server fills the macros from the label scaled to the
// portion (`applyPantry`). The logger picks the row by reading the whole list — there is no name
// matching here, by the same rule as exercise_id and list_id.
//
// Away from home the pantry says nothing about what he ate: get_pantry reports where he was at the
// moment he ate (`homeStatus`), and the tool text tells the model to log a generic estimate then unless
// he named the brand himself.
//
// Every write answers with what changed and an instruction to tell Jared, because a pantry change
// silently changes every later log of that food.

import { getClient } from './client.js';
import { ValidationError } from './helpers.js';
import { distance, fixAt, nyInstant } from './location.js';
import { isFiniteNumber, round10, PRODUCE_TYPES, type ProduceType } from './ingredients.js';

export interface PantryItem {
  id: number;
  names: string[];
  product: string;
  serving_amount: number; serving_unit: string; serving_g: number | null;
  calories: number; protein_g: number; carbs_g: number; fat_g: number;
  produce_type: ProduceType | null;
  retailer: string | null; item_id: string | null; notes: string | null;
  added_at: string; updated_at: string; retired_at: string | null; replaced_by: number | null;
}

// Farther than this from home (beyond the fix's own uncertainty) is away.
export const HOME_RADIUS_M = 150;

// ── Units ──
// A portion converts to label servings when it is the label's own unit, or both are volumes, or both
// are weights (directly, or through the label's printed gram weight). Anything else is refused: a
// density invented here would put a wrong number in the log that looks exactly like a right one.
const VOLUME_TSP: Record<string, number> = { tsp: 1, tbsp: 3, cup: 48, 'fl oz': 6, ml: 0.202884, l: 202.884 };
const MASS_G: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };
const UNIT_ALIASES: Record<string, string> = {
  teaspoon: 'tsp', tablespoon: 'tbsp', tbs: 'tbsp', tbl: 'tbsp', cups: 'cup', c: 'cup',
  'fluid ounce': 'fl oz', floz: 'fl oz', 'fl. oz': 'fl oz', milliliter: 'ml', millilitre: 'ml', liter: 'l', litre: 'l',
  gram: 'g', gr: 'g', kilogram: 'kg', ounce: 'oz', pound: 'lb', lbs: 'lb', servings: 'serving',
};

export function normUnit(u: string | null | undefined): string {
  let s = (u || '').trim().toLowerCase().replace(/\.$/, '').replace(/\s+/g, ' ');
  if (UNIT_ALIASES[s]) return UNIT_ALIASES[s];
  if (s.endsWith('s') && UNIT_ALIASES[s.slice(0, -1)]) return UNIT_ALIASES[s.slice(0, -1)];
  if (s.endsWith('s') && (VOLUME_TSP[s.slice(0, -1)] || MASS_G[s.slice(0, -1)])) return s.slice(0, -1);
  return s;
}

/** How many label servings `amount unit` is, or null when the units cannot be related. */
export function servingsFor(item: Pick<PantryItem, 'serving_amount' | 'serving_unit' | 'serving_g'>, amount: number, unit: string): number | null {
  const u = normUnit(unit), su = normUnit(item.serving_unit);
  const sa = Number(item.serving_amount), sg = item.serving_g == null ? null : Number(item.serving_g);
  if (u === 'serving') return amount;
  // A bare count ("2" eggs) against a counted label serving ("1 egg").
  if (u === su || (u === '' && !VOLUME_TSP[su] && !MASS_G[su])) return amount / sa;
  if (VOLUME_TSP[u] && VOLUME_TSP[su]) return (amount * VOLUME_TSP[u]) / (sa * VOLUME_TSP[su]);
  if (MASS_G[u]) {
    const grams = amount * MASS_G[u];
    if (MASS_G[su]) return grams / (sa * MASS_G[su]);
    if (sg) return grams / sg;
  }
  return null;
}

/** One logged ingredient built from a pantry row's label, scaled to the portion eaten. */
export function labelIngredient(item: PantryItem, amount: number, unit: string): Record<string, unknown> {
  if (!isFiniteNumber(amount) || amount <= 0) throw new ValidationError(`pantry #${item.id} (${item.product}): give a positive numeric 'amount'.`);
  const f = servingsFor(item, amount, unit);
  if (f == null) {
    throw new ValidationError(`pantry #${item.id} (${item.product}): can't convert '${unit || '(no unit)'}' to its label serving of ` +
      `${servingText(item)}. Give the amount in ${item.serving_unit}${item.serving_g ? ', grams' : ''}, another ` +
      `${VOLUME_TSP[normUnit(item.serving_unit)] ? 'volume (tsp, tbsp, cup, fl oz, ml)' : 'unit of the same kind'}, or 'serving'.`);
  }
  const out: Record<string, unknown> = {
    food: item.product, amount, unit: (unit || '').trim(),
    calories: round10(Number(item.calories) * f), protein_g: round10(Number(item.protein_g) * f),
    carbs_g: round10(Number(item.carbs_g) * f), fat_g: round10(Number(item.fat_g) * f),
  };
  if (item.produce_type) {
    const grams = item.serving_g ? Number(item.serving_g) * f : (MASS_G[normUnit(unit)] ? amount * MASS_G[normUnit(unit)] : null);
    if (grams == null) throw new ValidationError(`pantry #${item.id} (${item.product}) is produce and its label has no gram weight: give the amount in grams.`);
    out.produce_type = item.produce_type; out.produce_g = round10(grams);
  }
  return out;
}

/** Replace every raw ingredient that names a `pantry_id` with the label-derived one. Others pass through. */
export async function applyPantry(raw: any[]): Promise<any[]> {
  const ids = [...new Set(raw.filter(r => r?.pantry_id != null).map(r => Number(r.pantry_id)))];
  if (!ids.length) return raw;
  const { data, error } = await getClient().from('pantry_items').select('*').in('id', ids);
  if (error) throw new Error(error.message);
  const byId = new Map((data as PantryItem[]).map(r => [Number(r.id), r]));
  return raw.map(r => {
    if (r?.pantry_id == null) return r;
    const item = byId.get(Number(r.pantry_id));
    if (!item) throw new ValidationError(`pantry_id ${r.pantry_id} does not exist — call get_pantry for the ids.`);
    // A recipe ingredient's prep note is the caller's, not the label's: keep it.
    return { ...labelIngredient(item, r.amount, r.unit ?? ''), ...(r.notes ? { notes: r.notes } : {}) };
  });
}

// ── Home ──

export async function homeLocation(): Promise<{ lat: number; lon: number } | null> {
  const { data, error } = await getClient().from('app_settings').select('value').eq('key', 'home_location').maybeSingle();
  if (error) throw new Error(error.message);
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec((data as any)?.value ?? '');
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

export type HomeStatus =
  | { state: 'home'; metres: number; place: string | null }
  | { state: 'away'; metres: number; place: string | null }
  | { state: 'unknown'; why: string };

/** Home or away, from a fix. Away only when even the near edge of the fix's uncertainty is outside the radius. */
export function classify(home: { lat: number; lon: number }, fix: { lat: number; lon: number; acc: number | null; place?: string | null }): HomeStatus {
  const metres = Math.round(distance(home, fix));
  const place = fix.place ?? null;
  return metres - (fix.acc ?? 0) > HOME_RADIUS_M ? { state: 'away', metres, place } : { state: 'home', metres, place };
}

export async function homeStatus(at?: string): Promise<HomeStatus> {
  const home = await homeLocation();
  if (!home) return { state: 'unknown', why: 'no home location is saved (app_settings.home_location)' };
  const fix = await fixAt(at ? nyInstant(at) : undefined);
  if (!fix) return { state: 'unknown', why: 'no position is recorded around that time' };
  return classify(home, fix);
}

// ── Reading ──

function servingText(i: Pick<PantryItem, 'serving_amount' | 'serving_unit' | 'serving_g'>): string {
  const g = i.serving_g != null && normUnit(i.serving_unit) !== 'g' ? ` (${Number(i.serving_g)} g)` : '';
  return `${Number(i.serving_amount)}${i.serving_unit ? ` ${i.serving_unit}` : ''}${g}`;
}

export function itemLine(i: PantryItem): string {
  const src = i.retailer ? ` · ${i.retailer}${i.item_id ? ` ${i.item_id}` : ''}` : '';
  const retired = i.retired_at ? ` · RETIRED ${i.retired_at.slice(0, 10)}${i.replaced_by ? ` → #${i.replaced_by}` : ''}` : '';
  return `  #${i.id}  ${i.names.join(' / ')} — ${i.product} · per ${servingText(i)}: ${Number(i.calories)} cal, ` +
    `${Number(i.protein_g)}P/${Number(i.carbs_g)}C/${Number(i.fat_g)}F${i.produce_type ? ` · ${i.produce_type}` : ''}${src}` +
    `${i.notes ? ` · ${i.notes}` : ''}${retired}`;
}

export async function listPantry(includeRetired = false): Promise<PantryItem[]> {
  let q = getClient().from('pantry_items').select('*').order('id');
  if (!includeRetired) q = q.is('retired_at', null);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as PantryItem[];
}

export function statusText(s: HomeStatus, at?: string): string {
  const when = at ? `at ${at}` : 'now';
  const where = (x: { metres: number; place: string | null }) => `${x.place ? `${x.place}, ` : ''}${x.metres >= 1000 ? `${(x.metres / 1000).toFixed(1)} km` : `${x.metres} m`} from home`;
  if (s.state === 'home') return `He was AT HOME ${when} (${where(s)}). A food below that he names without a brand IS that product: put its pantry_id on the ingredient, with the portion as amount + unit, and leave the macros out — the server fills them from the label.`;
  if (s.state === 'away') return `He was AWAY from home ${when} (${where(s)}). Do NOT assume these brands: log a generic estimate unless he named the brand himself, and use a pantry_id only for a product he named.`;
  return `Where he was ${when} is unknown (${s.why}); treat it as home, and say in your reply that the pantry brand was assumed.`;
}

export async function getPantry(opts: { at?: string; include_retired?: boolean } = {}): Promise<string> {
  const [items, status] = await Promise.all([listPantry(!!opts.include_retired), homeStatus(opts.at)]);
  const head = statusText(status, opts.at);
  if (!items.length) return `${head}\n\nThe pantry is empty.`;
  return `${head}\n\n${items.filter(i => !i.retired_at).length} current items:\n${items.map(itemLine).join('\n')}`;
}

// ── Writing ──

export interface PantryInput {
  id?: number;
  names?: string[]; product?: string;
  serving_amount?: number; serving_unit?: string; serving_g?: number | null;
  calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number;
  produce_type?: string | null;
  retailer?: string | null; item_id?: string | null; notes?: string | null;
  replaces?: number;
}

const TELL = 'PANTRY CHANGED — tell Jared about this change in your reply: what it was and what it is now.';

/** Validate the fields a write sets. `full` requires everything a new row needs. */
export function pantryPatch(i: PantryInput, full: boolean): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  if (i.names !== undefined) {
    const names = (Array.isArray(i.names) ? i.names : []).map(n => String(n).trim().toLowerCase()).filter(Boolean);
    if (!names.length) throw new ValidationError('names: give at least one thing he calls it ("yum yum sauce").');
    p.names = [...new Set(names)];
  }
  if (i.product !== undefined) {
    if (!String(i.product).trim()) throw new ValidationError('product: give the brand and product name.');
    p.product = String(i.product).trim();
  }
  if (i.serving_amount !== undefined) {
    if (!isFiniteNumber(i.serving_amount) || i.serving_amount <= 0) throw new ValidationError('serving_amount must be a positive number.');
    p.serving_amount = i.serving_amount;
  }
  if (i.serving_unit !== undefined) p.serving_unit = String(i.serving_unit).trim();
  if (i.serving_g !== undefined) {
    if (i.serving_g !== null && (!isFiniteNumber(i.serving_g) || i.serving_g <= 0)) throw new ValidationError('serving_g must be a positive number of grams.');
    p.serving_g = i.serving_g;
  }
  for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g'] as const) {
    if (i[k] !== undefined) {
      if (!isFiniteNumber(i[k]) || (i[k] as number) < 0) throw new ValidationError(`${k} must be a non-negative number, from the label.`);
      p[k] = i[k];
    }
  }
  if (i.produce_type !== undefined) {
    if (i.produce_type !== null && i.produce_type !== '' && !PRODUCE_TYPES.includes(i.produce_type as ProduceType)) {
      throw new ValidationError(`produce_type must be one of ${PRODUCE_TYPES.join(', ')}, or omitted.`);
    }
    p.produce_type = i.produce_type || null;
  }
  if (i.retailer !== undefined) {
    if (i.retailer && !['walmart', 'amazon'].includes(i.retailer)) throw new ValidationError("retailer must be 'walmart' or 'amazon'.");
    p.retailer = i.retailer || null;
  }
  if (i.item_id !== undefined) p.item_id = i.item_id ? String(i.item_id) : null;
  if (i.notes !== undefined) p.notes = i.notes ? String(i.notes).trim() : null;
  if (full) {
    const missing = ['names', 'product', 'serving_amount', 'serving_unit', 'calories', 'protein_g', 'carbs_g', 'fat_g'].filter(k => p[k] === undefined);
    if (missing.length) throw new ValidationError(`a new pantry item needs ${missing.join(', ')} — all from the label.`);
  }
  return p;
}

async function getItem(id: number): Promise<PantryItem | null> {
  const { data, error } = await getClient().from('pantry_items').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PantryItem) ?? null;
}

export async function setPantryItem(i: PantryInput): Promise<string> {
  const db = getClient();
  if (i.id != null) {
    if (i.replaces != null) throw new ValidationError('give either id (edit that row) or replaces (a new product replacing one), not both.');
    const before = await getItem(Number(i.id));
    if (!before) throw new ValidationError(`pantry #${i.id} does not exist — call get_pantry.`);
    const patch = pantryPatch(i, false);
    if (!Object.keys(patch).length) return `Nothing to change on #${before.id}.`;
    const { data, error } = await db.from('pantry_items').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', before.id).select().single();
    if (error) throw new Error(error.message);
    return `${TELL}\nEdited:\n  before ${itemLine(before).trim()}\n  after  ${itemLine(data as PantryItem).trim()}`;
  }
  const row = pantryPatch(i, true);
  const old = i.replaces != null ? await getItem(Number(i.replaces)) : null;
  if (i.replaces != null && !old) throw new ValidationError(`replaces: pantry #${i.replaces} does not exist — call get_pantry.`);
  if (old?.retired_at) throw new ValidationError(`replaces: pantry #${old.id} is already retired.`);
  const { data, error } = await db.from('pantry_items').insert(row).select().single();
  if (error) throw new Error(error.message);
  const added = data as PantryItem;
  if (old) {
    const { error: e2 } = await db.from('pantry_items').update({ retired_at: new Date().toISOString(), replaced_by: added.id }).eq('id', old.id);
    if (e2) throw new Error(e2.message);
    return `${TELL}\nReplaced:\n  was ${itemLine(old).trim()}\n  now ${itemLine(added).trim()}`;
  }
  return `${TELL}\nAdded:\n  ${itemLine(added).trim()}`;
}

export async function removePantryItem(id: number): Promise<string> {
  const item = await getItem(Number(id));
  if (!item) throw new ValidationError(`pantry #${id} does not exist — call get_pantry.`);
  if (item.retired_at) return `#${item.id} is already retired.`;
  const { error } = await getClient().from('pantry_items').update({ retired_at: new Date().toISOString() }).eq('id', item.id);
  if (error) throw new Error(error.message);
  return `${TELL}\nRemoved (no longer in the pantry):\n  ${itemLine(item).trim()}`;
}
