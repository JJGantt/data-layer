import { getClient } from './client.js';
import { now, today, ensureEasternDate } from './helpers.js';

export interface WeightEntry { id: number; date: string; weight_lbs: number; logged_at: string; }
export interface NutritionTargetEntry { id: number; date: string; calories: number; protein_g: number; carbs_g: number; fat_g: number; logged_at: string; }

export async function getProfile(): Promise<{ height_in: number | null; updated: string | null }> {
  const { data } = await getClient().from('health_profile').select('height_in, updated').eq('id', 1).maybeSingle();
  return data || { height_in: null, updated: null };
}

export async function setHeight(heightIn: number): Promise<void> {
  const n = now();
  await getClient().from('health_profile').upsert({ id: 1, height_in: heightIn, updated: n }, { onConflict: 'id' });
}

export async function logWeight(weightLbs: number, date?: string): Promise<WeightEntry> {
  const d = date ? ensureEasternDate(date) : today();
  const n = now();
  const { data } = await getClient().from('weight_log')
    .insert({ date: d, weight_lbs: weightLbs, logged_at: n })
    .select().single();
  return data as WeightEntry;
}

export async function recentWeights(limit = 5): Promise<WeightEntry[]> {
  const { data } = await getClient().from('weight_log')
    .select('*').order('date', { ascending: false }).order('id', { ascending: false }).limit(limit);
  return (data ?? []) as WeightEntry[];
}

export async function setNutritionTargets(targets: { calories: number; protein_g: number; carbs_g: number; fat_g: number }, date?: string): Promise<NutritionTargetEntry> {
  const d = date ? ensureEasternDate(date) : today();
  const n = now();
  const { data } = await getClient().from('nutrition_targets')
    .insert({ date: d, calories: targets.calories, protein_g: targets.protein_g, carbs_g: targets.carbs_g, fat_g: targets.fat_g, logged_at: n })
    .select().single();
  return data as NutritionTargetEntry;
}

export async function recentTargets(limit = 3): Promise<NutritionTargetEntry[]> {
  const { data } = await getClient().from('nutrition_targets')
    .select('*').order('date', { ascending: false }).order('id', { ascending: false }).limit(limit);
  return (data ?? []) as NutritionTargetEntry[];
}

export interface ProduceTargets { veg_g: number; dark_green_g: number; fruit_g: number; }

// Fallbacks matching the migration's seeded values, so a missing/garbled row can't zero the goals.
const PRODUCE_TARGET_DEFAULTS: ProduceTargets = { veg_g: 300, dark_green_g: 150, fruit_g: 250 };
const PRODUCE_TARGET_KEYS: Record<string, keyof ProduceTargets> = {
  produce_target_veg_g: 'veg_g', produce_target_dark_green_g: 'dark_green_g', produce_target_fruit_g: 'fruit_g',
};

// Daily produce goals. These are FIXED constants in app_settings — unlike the macro targets, which the
// hub's adaptive-maintenance engine recomputes from weight trend + intake on every stream build.
// veg_g INCLUDES dark_green_g (dark greens are a floor within the vegetable total, not a separate bucket).
export async function produceTargets(): Promise<ProduceTargets> {
  const { data } = await getClient().from('app_settings').select('key, value').like('key', 'produce_target_%');
  const out = { ...PRODUCE_TARGET_DEFAULTS };
  for (const row of (data ?? []) as { key: string; value: string }[]) {
    const field = PRODUCE_TARGET_KEYS[row.key];
    const v = Number(row.value);
    if (field && Number.isFinite(v)) out[field] = v;
  }
  return out;
}

export function formatProduceTargets(t: ProduceTargets): string {
  return `Produce targets (daily, fixed): ${t.veg_g}g vegetables (of which ${t.dark_green_g}g dark green) · ${t.fruit_g}g fruit`;
}

export function formatProfile(profile: { height_in: number | null }, weights: WeightEntry[], targets: NutritionTargetEntry[] = [], produce?: ProduceTargets): string {
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
    for (const e of weights) lines.push(`  ${e.date}: ${e.weight_lbs} lbs`);
  } else {
    lines.push('Weight log: empty');
  }
  if (targets.length) {
    const t = targets[0];
    lines.push(`\nNutrition targets (as of ${t.date}): ${t.calories} cal, ${t.protein_g}g protein, ${t.carbs_g}g carbs, ${t.fat_g}g fat`);
    if (targets.length > 1) {
      lines.push(`\nTarget history (last ${targets.length}):`);
      for (const e of targets) lines.push(`  ${e.date}: ${e.calories} cal, ${e.protein_g}g P / ${e.carbs_g}g C / ${e.fat_g}g F`);
    }
  } else {
    lines.push('\nNutrition targets: not set');
  }
  if (produce) lines.push(`\n${formatProduceTargets(produce)}`);
  return lines.join('\n');
}
