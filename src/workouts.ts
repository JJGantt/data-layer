import { getClient } from './client.js';
import { now, toEastern, fmtWeight } from './helpers.js';

export const VALID_CATEGORIES = ['push', 'pull', 'legs', 'core', 'cardio'] as const;
const CAT_ORDER: Record<string, number> = { push: 0, pull: 1, legs: 2, core: 3, cardio: 4 };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// High-fidelity muscle taxonomy, grouped + ordered for display. Exercises map to these via
// fractional set counting (1.0 primary / 0.5 secondary), stored in exercise_muscles.
const MUSCLE_GROUPS: { group: string; muscles: { slug: string; label: string }[] }[] = [
  { group: 'Legs', muscles: [
    { slug: 'quads', label: 'Quads' }, { slug: 'rectus_femoris', label: 'Rectus femoris' },
    { slug: 'hamstrings', label: 'Hamstrings' }, { slug: 'glutes', label: 'Glutes' },
    { slug: 'adductors', label: 'Adductors' }, { slug: 'hip_flexors', label: 'Hip flexors' },
    { slug: 'gastrocnemius', label: 'Gastrocnemius' }, { slug: 'soleus', label: 'Soleus' } ] },
  { group: 'Push', muscles: [
    { slug: 'upper_chest', label: 'Upper chest' }, { slug: 'lower_chest', label: 'Lower chest' },
    { slug: 'front_delts', label: 'Front delts' }, { slug: 'side_delts', label: 'Side delts' },
    { slug: 'triceps_long', label: 'Triceps (long head)' }, { slug: 'triceps_lateral', label: 'Triceps (lateral)' } ] },
  { group: 'Pull', muscles: [
    { slug: 'lats', label: 'Lats' }, { slug: 'upper_traps', label: 'Upper traps' },
    { slug: 'mid_back', label: 'Mid-back' }, { slug: 'rear_delts', label: 'Rear delts' },
    { slug: 'biceps', label: 'Biceps' }, { slug: 'forearms', label: 'Forearms' } ] },
  { group: 'Core', muscles: [
    { slug: 'abs', label: 'Abs' }, { slug: 'obliques', label: 'Obliques' },
    { slug: 'erectors', label: 'Lower back' } ] },
];
const MUSCLE_LABEL: Record<string, string> = Object.fromEntries(
  MUSCLE_GROUPS.flatMap(g => g.muscles.map(m => [m.slug, m.label])));
export const VALID_MUSCLES = Object.keys(MUSCLE_LABEL);

/** Validate a fractional muscle map: { slug: contribution } with known slugs and 0 < c <= 1. */
export function validateMuscles(muscles: unknown): Record<string, number> {
  if (typeof muscles !== 'object' || muscles === null || Array.isArray(muscles))
    throw new Error(`muscles required for a new exercise: an object like {"quads":1.0,"glutes":0.5}. Valid muscles: ${VALID_MUSCLES.join(', ')}`);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(muscles as Record<string, unknown>)) {
    const slug = String(k).trim().toLowerCase();
    if (!MUSCLE_LABEL[slug]) throw new Error(`invalid muscle '${k}'. Valid muscles: ${VALID_MUSCLES.join(', ')}`);
    const c = Number(v);
    if (!(c > 0 && c <= 1)) throw new Error(`muscle '${k}' contribution must be > 0 and <= 1 (use 1.0 primary, 0.5 secondary)`);
    out[slug] = c;
  }
  if (!Object.keys(out).length) throw new Error('muscles map cannot be empty for a new exercise');
  return out;
}

/** Validate + normalize a category set: a non-empty subset of VALID_CATEGORIES. Throws on bad input. */
export function validateCategories(cats: unknown): string[] {
  if (!Array.isArray(cats) || cats.length === 0)
    throw new Error(`categories required: a non-empty set drawn from ${VALID_CATEGORIES.join(', ')}`);
  const norm = [...new Set(cats.map(c => String(c).trim().toLowerCase()))];
  for (const c of norm)
    if (!(VALID_CATEGORIES as readonly string[]).includes(c))
      throw new Error(`invalid category '${c}'. Allowed: ${VALID_CATEGORIES.join(', ')}`);
  return norm.sort((a, b) => CAT_ORDER[a] - CAT_ORDER[b]);
}

/** Human label for a derived category set: "Full body", "Push / Legs", "Pull / Legs + Core". */
export function categoryLabel(cats: string[]): string {
  if (!cats.length) return 'Untyped';
  const ppl = ['push', 'pull', 'legs'].filter(c => cats.includes(c));
  const extra = cats.filter(c => !['push', 'pull', 'legs'].includes(c));
  const parts: string[] = ppl.length === 3 ? ['Full body'] : ppl.map(cap);
  parts.push(...extra.map(cap));
  return parts.join(' / ') || 'Untyped';
}

// ---- catalog (normalized: exercise_catalog + exercise_muscles) ----
export interface CatalogExercise { id: number; name: string; categories: string[]; muscles: Record<string, number>; }

/** Categories + muscle map keyed by exercise name, loaded once per operation. */
async function catalogMaps(): Promise<{ cats: Map<string, string[]>; muscles: Map<string, { muscle: string; contribution: number }[]> }> {
  const sb = getClient();
  const { data: catRows } = await sb.from('exercise_catalog').select('name, categories');
  const { data: muscleRows } = await sb.from('exercise_muscles').select('name, muscle, contribution');
  const cats = new Map<string, string[]>();
  for (const c of (catRows ?? [])) cats.set(c.name.toLowerCase(), (c.categories ?? []) as string[]);
  const muscles = new Map<string, { muscle: string; contribution: number }[]>();
  for (const m of (muscleRows ?? [])) {
    const k = m.name.toLowerCase();
    if (!muscles.has(k)) muscles.set(k, []);
    muscles.get(k)!.push({ muscle: m.muscle, contribution: m.contribution });
  }
  return { cats, muscles };
}

export async function getCatalog(): Promise<{ categories: string[]; muscles: string[]; exercises: CatalogExercise[] }> {
  const sb = getClient();
  const { data: catRows } = await sb.from('exercise_catalog').select('id, name, categories');
  const { data: muscleRows } = await sb.from('exercise_muscles').select('exercise_id, muscle, contribution');
  const byId = new Map<number, Record<string, number>>();
  for (const m of (muscleRows ?? [])) {
    if (!byId.has(m.exercise_id)) byId.set(m.exercise_id, {});
    byId.get(m.exercise_id)![m.muscle] = m.contribution;
  }
  // The id leads, because it is the only thing a caller may pass back.
  const exercises = (catRows ?? []).map(c => ({
    id: c.id as number, name: c.name, categories: (c.categories ?? []) as string[], muscles: byId.get(c.id) ?? {},
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { categories: [...VALID_CATEGORIES], muscles: [...VALID_MUSCLES], exercises };
}

type CatalogRow = { id: number; name: string; categories: string[] };

/**
 * The catalog, whole. An exercise is named by its `id` and nothing else: no matching happens here or
 * anywhere else, because there is no longer a question to answer — an id exists or it does not.
 *
 * There used to be a matcher, and its history is the argument against it. The name was the identity,
 * so an exact comparison decided existence and a plural ("overhead tricep extensions") read as an
 * unknown movement. Loosening the comparison only moved the risk: anything willing to accept a near
 * miss is willing to write a set against the WRONG exercise, and every volume figure derives from
 * that association.
 */
async function loadCatalog(): Promise<CatalogRow[]> {
  const { data } = await getClient().from('exercise_catalog').select('id, name, categories');
  return (data ?? []).map((r) => ({ id: r.id as number, name: r.name as string, categories: (r.categories ?? []) as string[] }));
}

/** Resolve an id to its catalog row, or throw naming what is actually on offer. */
async function requireExercise(id: unknown): Promise<CatalogRow> {
  const n = Number(id);
  if (!Number.isInteger(n)) throw new Error(`exercise_id must be an integer id from get_workout_catalog, got ${JSON.stringify(id)}`);
  const rows = await loadCatalog();
  const hit = rows.find((r) => r.id === n);
  if (!hit) throw new Error(`No exercise with id ${n}. Call get_workout_catalog for the ids; add a genuinely new movement with upsert_catalog_exercise, which returns one.`);
  return hit;
}

/**
 * Create or replace a catalog entry (categories + fractional muscle map). Fixes mistakes too.
 *
 * This is the ONE place an exercise is named by a string, because naming is what it is for. Matching
 * is exact and case-insensitive: near-miss matching here would silently overwrite the muscle map of a
 * DIFFERENT movement. Returns the id, so a caller that has just registered something can log against
 * it without a second lookup.
 */
export async function upsertCatalogExercise(name: string, categories: unknown, muscles: unknown): Promise<CatalogExercise> {
  const sb = getClient();
  const nm = String(name).trim();
  if (!nm) throw new Error('exercise name required');
  const cats = validateCategories(categories);
  const mus = validateMuscles(muscles);
  const existing = (await loadCatalog()).find((r) => r.name.toLowerCase() === nm.toLowerCase()) ?? null;
  const canonical = existing?.name ?? nm;
  if (existing) {
    await sb.from('exercise_catalog').update({ categories: cats }).eq('name', canonical);
    await sb.from('exercise_muscles').delete().eq('name', canonical);
  } else {
    await sb.from('exercise_catalog').insert({ name: canonical, categories: cats });
  }
  const id = existing?.id
    ?? (await loadCatalog()).find((r) => r.name.toLowerCase() === canonical.toLowerCase())!.id;
  const rows = Object.entries(mus).map(([muscle, contribution]) => ({ name: canonical, exercise_id: id, muscle, contribution }));
  if (rows.length) await sb.from('exercise_muscles').insert(rows);
  return { id, name: canonical, categories: cats, muscles: mus };
}

// ---- sets (the flat log) ----
export interface SetRow { id: number; occurred_at: string; exercise: string; weight_lbs: number; reps: number; }

/**
 * A caller-supplied set time, normalized for the `sets.occurred_at` column.
 *
 * That column is NAIVE LOCAL wall-clock — it is what `now()` writes — so this deliberately does NOT
 * go through `ensureEastern`. That helper reads a bare timestamp as UTC and converts, which would
 * silently move a stated "1:51pm" back four hours and file the set under the wrong day. What the
 * clock read is what gets stored.
 *
 * Strict on purpose. A set written to the wrong day is invisible on the surfaces that would show it
 * and only turns up later as a corrupted week of volume, so an unparseable stamp raises rather than
 * being guessed at. A bare date lands at noon, the same convention nutrition's occurred_at uses, so
 * it cannot spill into an adjacent day whichever way the boundary is read.
 */
function normalizeSetTime(value: string): string {
  const raw = String(value ?? '').trim();
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`occurred_at must be LOCAL wall-clock 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD'), got '${raw}'`);
  const timed = m[4] !== undefined;
  const [y, mo, d] = m.slice(1, 4).map(Number);
  const h = timed ? Number(m[4]) : 12;
  const mi = timed ? Number(m[5]) : 0;
  const s = timed && m[6] !== undefined ? Number(m[6]) : 0;
  // The regex admits 2026-02-30 and 25:00; round-tripping through Date is what rejects them.
  const dt = new Date(y, mo - 1, d, h, mi, s);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d
      || dt.getHours() !== h || dt.getMinutes() !== mi || dt.getSeconds() !== s) {
    throw new Error(`occurred_at is not a real date/time: '${raw}'`);
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${p(mi)}:${p(s)}`;
}

/**
 * Log one or more sets. Each set is its own timestamped row.
 * An exercise is named by its catalog id, never by a string — see loadCatalog for why.
 * Sets in a single call share the call's timestamp (logged together); log set-by-set for real rest gaps.
 * A set may override that with its own `occurred_at` — for a set being written down after the fact,
 * which is the only way to place one at a time that has already passed.
 */
export async function logSets(items: { exercise_id: number; weight_lbs: number; reps: number; occurred_at?: string }[]): Promise<SetRow[]> {
  const sb = getClient();
  // now() is voice-aware: for a voice-logged set it resolves to the audio CAPTURE START (when he spoke),
  // not the current instant — see helpers.ts. That's what makes rest gaps between sets read true.
  const ts = now();
  // Read once for the whole call rather than per set.
  const catalog = await loadCatalog();
  const rows: { occurred_at: string; exercise_id: number; weight_lbs: number; reps: number }[] = [];
  for (const it of items) {
    const n = Number(it.exercise_id);
    if (!Number.isInteger(n)) throw new Error(`each set needs an integer exercise_id from get_workout_catalog, got ${JSON.stringify(it.exercise_id)}`);
    const entry = catalog.find((r) => r.id === n);
    if (!entry) throw new Error(`No exercise with id ${n}. Call get_workout_catalog for the ids; a genuinely new movement is registered with upsert_catalog_exercise, which returns one.`);
    if (!Number.isFinite(it.weight_lbs) || it.weight_lbs < 0) throw new Error(`'${entry.name}': weight_lbs must be >= 0 (bodyweight = 0)`);
    if (!Number.isInteger(it.reps) || it.reps <= 0) throw new Error(`'${entry.name}': reps must be a positive integer`);
    // Only a set that states its own time departs from the call's shared stamp, so logging several
    // sets together still records them as one moment. The `exercise` column is filled by the
    // sets_resolve_exercise trigger (migration 00075) from this id — never written here.
    rows.push({ occurred_at: it.occurred_at ? normalizeSetTime(it.occurred_at) : ts, exercise_id: n, weight_lbs: it.weight_lbs, reps: it.reps });
  }
  const { data } = await sb.from('sets').insert(rows).select();
  return (data ?? []) as SetRow[];
}

export async function removeSet(id: number): Promise<SetRow | null> {
  const sb = getClient();
  const { data: row } = await sb.from('sets').select('*').eq('id', id).maybeSingle();
  if (!row) return null;
  await sb.from('sets').delete().eq('id', id);
  return row as SetRow;
}

/**
 * Edit a logged set in place. Every field is optional and only what is passed is written, so a set's
 * movement, load, reps or time can each be corrected without restating — or disturbing — the others.
 *
 * Changing the exercise is why this takes a patch rather than a fixed triple: the alternative was
 * delete-and-relog, which restamps `occurred_at` and so destroys the rest gap that the timestamp
 * exists to record.
 */
export async function updateSet(
  id: number,
  patch: { exercise_id?: number; weight_lbs?: number; reps?: number; occurred_at?: string },
): Promise<SetRow | null> {
  const sb = getClient();
  const upd: Record<string, unknown> = {};
  if (patch.exercise_id !== undefined) {
    // The id is written; the `exercise` column follows from it via the sets_resolve_exercise trigger
    // (00075). Resolved here anyway so a bad id fails with a useful message instead of a raw
    // constraint violation from the database.
    upd.exercise_id = (await requireExercise(patch.exercise_id)).id;
  }
  if (patch.weight_lbs !== undefined) {
    if (!Number.isFinite(patch.weight_lbs) || patch.weight_lbs < 0) throw new Error('weight_lbs must be >= 0 (bodyweight = 0)');
    upd.weight_lbs = patch.weight_lbs;
  }
  if (patch.reps !== undefined) {
    if (!Number.isInteger(patch.reps) || patch.reps <= 0) throw new Error('reps must be a positive integer');
    upd.reps = patch.reps;
  }
  if (patch.occurred_at !== undefined) upd.occurred_at = normalizeSetTime(patch.occurred_at);
  if (!Object.keys(upd).length) throw new Error('nothing to change — pass at least one of exercise_id, weight_lbs, reps, occurred_at');
  const { data } = await sb.from('sets').update(upd).eq('id', id).select().maybeSingle();
  return (data ?? null) as SetRow | null;
}

/** All sets for a given local day (defaults today), ordered by time. */
export async function getDaySets(date?: string): Promise<{ date: string; sets: SetRow[] }> {
  const day = (date && /^\d{4}-\d{2}-\d{2}$/.test(date.trim())) ? date.trim() : toEastern(new Date()).slice(0, 10);
  const { data } = await getClient().from('sets').select('*')
    .gte('occurred_at', `${day}T00:00:00`).lte('occurred_at', `${day}T23:59:59`).order('occurred_at');
  return { date: day, sets: (data ?? []) as SetRow[] };
}

/** Recent workout days (grouped from sets), newest first. */
export async function listWorkoutDays(limit = 10): Promise<{ date: string; setCount: number; categories: string[]; exercises: string[] }[]> {
  const { data } = await getClient().from('sets').select('occurred_at, exercise').order('occurred_at', { ascending: false }).limit(2000);
  const { cats } = await catalogMaps();
  const byDay = new Map<string, { setCount: number; cats: Set<string>; ex: Set<string> }>();
  for (const s of (data ?? [])) {
    const d = String(s.occurred_at).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, { setCount: 0, cats: new Set(), ex: new Set() });
    const e = byDay.get(d)!;
    e.setCount++; e.ex.add(s.exercise);
    for (const c of (cats.get(String(s.exercise).toLowerCase()) ?? [])) e.cats.add(c);
  }
  return [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, limit)
    .map(([date, e]) => ({ date, setCount: e.setCount, categories: [...e.cats].sort((a, b) => CAT_ORDER[a] - CAT_ORDER[b]), exercises: [...e.ex] }));
}

export async function getExerciseHistory(name: string, limit = 60): Promise<{ date: string; sets: { weight_lbs: number; reps: number }[] }[]> {
  const { data } = await getClient().from('sets').select('occurred_at, weight_lbs, reps')
    .ilike('exercise', name.trim()).order('occurred_at', { ascending: false }).limit(limit);
  const byDay = new Map<string, { weight_lbs: number; reps: number }[]>();
  for (const s of (data ?? [])) {
    const d = String(s.occurred_at).slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push({ weight_lbs: s.weight_lbs, reps: s.reps });
  }
  return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([date, sets]) => ({ date, sets }));
}

export interface MuscleVolume { muscle: string; label: string; group: string; sets: number; }

/** Trailing-window fractional set volume per muscle, summed across all logged sets. */
export async function getWeeklyVolume(days = 7): Promise<{ days: number; volumes: MuscleVolume[] }> {
  const since = toEastern(new Date(Date.now() - days * 86400000)).slice(0, 10);
  const { data: setRows } = await getClient().from('sets').select('exercise, muscles_override').gte('occurred_at', since);
  const { muscles } = await catalogMaps();

  const totals = new Map<string, number>();
  for (const s of (setRows ?? [])) {
    const override = (s as any).muscles_override as Record<string, number> | null;
    const map = override
      ? Object.entries(override).map(([muscle, contribution]) => ({ muscle, contribution }))
      : (muscles.get(String(s.exercise).toLowerCase()) ?? []);
    for (const mm of map) totals.set(mm.muscle, (totals.get(mm.muscle) ?? 0) + mm.contribution);
  }
  const volumes = MUSCLE_GROUPS.flatMap(g => g.muscles.map(m => ({
    muscle: m.slug, label: m.label, group: g.group,
    sets: Math.round((totals.get(m.slug) ?? 0) * 10) / 10,
  })));
  return { days, volumes };
}

// Weekly effective-set target per muscle, mirroring the hub's `server/lib/volume.js` (TARGET_DEFAULT
// plus its TARGETS overrides). Duplicated rather than shared because the two repos ship separately;
// if a target moves there it has to move here too, or this report calls a muscle short of a goal the
// wall says it has met.
const TARGET_DEFAULT = 14;
const TARGETS: Record<string, number> = { abs: 8, obliques: 8, erectors: 8, hip_flexors: 8 };
const targetFor = (slug: string) => TARGETS[slug] ?? TARGET_DEFAULT;

export function formatWeeklyVolume(result: { days: number; volumes: MuscleVolume[] }): string {
  // The old fixed 10–20 band, re-expressed as a fraction of the target so it tracks a lowered one:
  // 10/14 and 20/14 reproduce it exactly for a muscle still on the default.
  const status = (s: number, t: number) => s === 0 ? '▫️ none'
    : s < t * (10 / 14) ? '⚠️ below' : s <= t * (20 / 14) ? '✅' : '🔺 high';
  const lines = [`**Weekly volume** — trailing ${result.days} days, fractional sets / weekly target`];
  let lastGroup = '';
  for (const v of result.volumes) {
    if (v.group !== lastGroup) { lines.push('', `_${v.group}_`); lastGroup = v.group; }
    const t = targetFor(v.muscle);
    lines.push(`  ${v.label.padEnd(20)} ${String(v.sets).padStart(4)} / ${t}  ${status(v.sets, t)}`);
  }
  lines.push('', '_Smaller muscles (calves, arms, delts) tolerate the upper end; legs/back the middle._');
  return lines.join('\n');
}

/** A day's sets as a grouped table (by exercise, in order first logged). */
export async function formatDay(date?: string): Promise<string> {
  const { date: day, sets } = await getDaySets(date);
  if (!sets.length) return `No sets logged for ${day}.`;
  const { cats } = await catalogMaps();
  const order: string[] = [];
  const byEx = new Map<string, SetRow[]>();
  for (const s of sets) {
    if (!byEx.has(s.exercise)) { byEx.set(s.exercise, []); order.push(s.exercise); }
    byEx.get(s.exercise)!.push(s);
  }
  const allCats = new Set<string>();
  for (const ex of order) for (const c of (cats.get(ex.toLowerCase()) ?? [])) allCats.add(c);
  const lines = [
    `**${categoryLabel([...allCats].sort((a, b) => CAT_ORDER[a] - CAT_ORDER[b]))}** (${day})`,
    '', '| Exercise | Sets | Reps | Weight |', '|---|---|---|---|',
  ];
  for (const ex of order) {
    const list = byEx.get(ex)!;
    const reps = list.map(s => s.reps), weights = list.map(s => s.weight_lbs);
    const repsStr = new Set(reps).size === 1 ? String(reps[0]) : reps.join(', ');
    const weightStr = new Set(weights).size === 1 ? fmtWeight(weights[0]) : weights.map(fmtWeight).join(', ');
    lines.push(`| ${ex} | ${list.length} | ${repsStr} | ${weightStr} |`);
  }
  // Per-set ids so a specific set can be targeted with update_set / remove_set (e.g. "the 2nd set").
  lines.push('', 'Individual sets (use the id to edit or remove one):');
  for (const ex of order) {
    byEx.get(ex)!.forEach((s, i) => {
      lines.push(`- \`${s.id}\` ${ex} — set ${i + 1}: ${fmtWeight(s.weight_lbs)} × ${s.reps}`);
    });
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- set watcher

export type SetWatcher = {
  exercise: string | null;
  weight_lbs: number | null;
  armed_at: string | null;
  last_set_at: string | null;
};

/** Ten minutes with no set disarms it, so a forgotten watcher cannot capture the
 *  next day's arm swing as an Incline Press. Mirrors set_watcher_is_armed() in SQL. */
export function watcherArmed(w: SetWatcher): boolean {
  if (!w.exercise) return false;
  const t = w.last_set_at || w.armed_at;
  if (!t) return false;
  return Date.now() - new Date(t).getTime() < 10 * 60 * 1000;
}

/**
 * Arm the set watcher: from now on, every set the watch counts is logged as this
 * exercise at this weight, with its own timestamp.
 *
 * The watch reports rep counts and nothing else — it has no idea what movement is
 * being performed. This is where that meaning is attached, and it must be armed
 * BEFORE the sets arrive: a report landing unarmed is stored but never becomes
 * training data, so a forgotten arming loses the log rather than corrupting it.
 */
export async function setWatcher(exercise_id: number, weight_lbs: number): Promise<SetWatcher> {
  const sb = getClient();
  if (!Number.isFinite(weight_lbs) || weight_lbs < 0) {
    throw new Error('weight_lbs must be >= 0 (bodyweight = 0)');
  }
  // Named by id exactly as log_set is, so a watch-logged set is indistinguishable from a hand-logged
  // one and inherits the same muscle map. The catalog NAME is stored alongside because 00046's
  // trigger reads it when it turns a watch report into a set.
  const entry = await requireExercise(exercise_id);
  const { data } = await sb.from('set_watcher')
    .update({ exercise: entry.name, exercise_id: entry.id, weight_lbs, armed_at: new Date().toISOString(), last_set_at: null })
    .eq('id', 1).select().maybeSingle();
  return data as SetWatcher;
}

/** Stop logging watch-counted sets. */
export async function clearWatcher(): Promise<void> {
  const sb = getClient();
  await sb.from('set_watcher')
    .update({ exercise: null, weight_lbs: null, armed_at: null, last_set_at: null })
    .eq('id', 1);
}

export async function getWatcher(): Promise<SetWatcher> {
  const sb = getClient();
  const { data } = await sb.from('set_watcher').select('*').eq('id', 1).maybeSingle();
  return (data || { exercise: null, weight_lbs: null, armed_at: null, last_set_at: null }) as SetWatcher;
}

export function formatWatcher(w: SetWatcher): string {
  if (!w.exercise) return 'Rep watcher is OFF — sets counted by the watch will not be logged.';
  const live = watcherArmed(w);
  const since = w.last_set_at
    ? `last set ${new Date(w.last_set_at).toLocaleTimeString()}`
    : `armed ${w.armed_at ? new Date(w.armed_at).toLocaleTimeString() : '?'}, no sets yet`;
  return live
    ? `Rep watcher SET: ${w.exercise} @ ${w.weight_lbs} lbs (${since}). Sets counted by the watch log automatically.`
    : `Rep watcher EXPIRED (${w.exercise} @ ${w.weight_lbs} lbs, ${since}). Ten minutes with no set clears it — set it again to resume.`;
}
