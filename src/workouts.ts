import { getClient } from './client.js';
import { now, uuid, fmtWeight, toEastern } from './helpers.js';

export const VALID_CATEGORIES = ['push', 'pull', 'legs', 'core', 'cardio'] as const;
const CAT_ORDER: Record<string, number> = { push: 0, pull: 1, legs: 2, core: 3, cardio: 4 };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// High-fidelity muscle taxonomy (20 regions), grouped + ordered for display. Each
// exercise maps to these via fractional set counting (1.0 primary / 0.5 secondary).
const MUSCLE_GROUPS: { group: string; muscles: { slug: string; label: string }[] }[] = [
  { group: 'Legs', muscles: [
    { slug: 'quads', label: 'Quads' }, { slug: 'rectus_femoris', label: 'Rectus femoris' },
    { slug: 'hamstrings', label: 'Hamstrings' }, { slug: 'glutes', label: 'Glutes' },
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
    { slug: 'abs', label: 'Abs' }, { slug: 'obliques', label: 'Obliques' } ] },
];
const MUSCLE_LABEL: Record<string, string> = Object.fromEntries(
  MUSCLE_GROUPS.flatMap(g => g.muscles.map(m => [m.slug, m.label])));
const MUSCLE_ORDER: Record<string, number> = Object.fromEntries(
  MUSCLE_GROUPS.flatMap(g => g.muscles).map((m, i) => [m.slug, i]));
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

/** A session's category set is the union of its exercises' categories. */
function deriveCategories(exercises: { categories: string[] }[]): string[] {
  const s = new Set<string>();
  for (const ex of exercises) for (const c of (ex.categories ?? [])) s.add(c);
  return [...s].sort((a, b) => CAT_ORDER[a] - CAT_ORDER[b]);
}

/** Human label for a derived session set: "Full body", "Push / Legs", "Pull / Legs + Core". */
export function categoryLabel(cats: string[]): string {
  if (!cats.length) return 'Untyped';
  const ppl = ['push', 'pull', 'legs'].filter(c => cats.includes(c));
  const extra = cats.filter(c => !['push', 'pull', 'legs'].includes(c));
  const parts: string[] = ppl.length === 3 ? ['Full body'] : ppl.map(cap);
  parts.push(...extra.map(cap));
  return parts.join(' / ') || 'Untyped';
}

export interface WorkoutSet { set_num: number; weight_lbs: number; reps: number; }
export interface Exercise { id: string; name: string; categories: string[]; sets: WorkoutSet[]; }
export interface WorkoutSession { id: string; date: string; categories: string[]; notes: string; exercises: Exercise[]; }
export interface WorkoutSummary { id: string; date: string; categories: string[]; exerciseCount: number; notes: string; }

async function loadExercises(sessionId: string): Promise<Exercise[]> {
  const sb = getClient();
  const { data: exRows } = await sb.from('exercises').select('id, name, categories')
    .eq('session_id', sessionId).order('sort_order');
  if (!exRows?.length) return [];
  const exercises: Exercise[] = [];
  for (const ex of exRows) {
    const { data: sets } = await sb.from('exercise_sets').select('set_num, weight_lbs, reps')
      .eq('exercise_id', ex.id).order('set_num');
    exercises.push({ id: ex.id, name: ex.name, categories: (ex.categories ?? []) as string[], sets: (sets ?? []) as WorkoutSet[] });
  }
  return exercises;
}

export async function getWorkout(idPrefix: string): Promise<WorkoutSession | null> {
  const id = await resolveSessionId(idPrefix);
  if (!id) return null;
  const { data: row } = await getClient().from('workout_sessions').select('*').eq('id', id).maybeSingle();
  if (!row) return null;
  const exercises = await loadExercises(row.id);
  return { id: row.id, date: row.date, notes: row.notes, categories: deriveCategories(exercises), exercises };
}

export async function listWorkouts(limit = 10): Promise<WorkoutSummary[]> {
  const sb = getClient();
  const { data: rows } = await sb.from('workout_sessions').select('id, date, notes')
    .order('date', { ascending: false }).limit(limit);
  if (!rows?.length) return [];
  const summaries: WorkoutSummary[] = [];
  for (const r of rows) {
    const { data: exRows } = await sb.from('exercises').select('categories').eq('session_id', r.id);
    const cats = deriveCategories((exRows ?? []).map(e => ({ categories: (e.categories ?? []) as string[] })));
    summaries.push({ id: r.id, date: r.date, notes: r.notes, categories: cats, exerciseCount: (exRows ?? []).length });
  }
  return summaries;
}

export interface CatalogExercise { name: string; categories: string[]; muscles: Record<string, number>; }

/** The canonical exercise library: names, categories, and fractional muscle maps. */
export async function getCatalog(): Promise<{ categories: string[]; muscles: string[]; exercises: CatalogExercise[] }> {
  const sb = getClient();
  const { data: catRows } = await sb.from('exercise_catalog').select('name, categories');
  const { data: muscleRows } = await sb.from('exercise_muscles').select('name, muscle, contribution');
  const byName = new Map<string, Record<string, number>>();
  for (const m of (muscleRows ?? [])) {
    if (!byName.has(m.name)) byName.set(m.name, {});
    byName.get(m.name)![m.muscle] = m.contribution;
  }
  const exercises = (catRows ?? []).map(c => ({
    name: c.name, categories: (c.categories ?? []) as string[], muscles: byName.get(c.name) ?? {},
  })).sort((a, b) => a.name.localeCompare(b.name));
  return { categories: [...VALID_CATEGORIES], muscles: [...VALID_MUSCLES], exercises };
}

/** Look up a canonical catalog entry by name (case-insensitive). Returns null if unknown. */
async function lookupCatalog(name: string): Promise<{ name: string; categories: string[] } | null> {
  const { data } = await getClient().from('exercise_catalog').select('name, categories').ilike('name', name.trim()).maybeSingle();
  return data ? { name: data.name, categories: (data.categories ?? []) as string[] } : null;
}

/** Register a genuinely new exercise in the canonical catalog with its fractional muscle map. */
async function registerCatalogEntry(name: string, categories: string[], muscles: Record<string, number>): Promise<void> {
  const sb = getClient();
  await sb.from('exercise_catalog').insert({ name, categories });
  const rows = Object.entries(muscles).map(([muscle, contribution]) => ({ name, muscle, contribution }));
  if (rows.length) await sb.from('exercise_muscles').insert(rows);
}

export async function getExerciseHistory(name: string, limit = 20): Promise<{ date: string; session_id: string; categories: string[]; sets: WorkoutSet[] }[]> {
  const sb = getClient();
  const { data: exRows } = await sb.from('exercises').select('id, name, categories, session_id, workout_sessions(id, date)')
    .ilike('name', name).order('session_id', { ascending: false }).limit(limit);
  if (!exRows?.length) return [];
  const results: { date: string; session_id: string; categories: string[]; sets: WorkoutSet[] }[] = [];
  for (const ex of exRows) {
    const session = (ex as any).workout_sessions;
    if (!session) continue;
    const { data: sets } = await sb.from('exercise_sets').select('set_num, weight_lbs, reps')
      .eq('exercise_id', ex.id).order('set_num');
    results.push({
      date: session.date.slice(0, 10),
      session_id: session.id.slice(0, 8),
      categories: (ex.categories ?? []) as string[],
      sets: (sets ?? []) as WorkoutSet[],
    });
  }
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results.slice(0, limit);
}

export interface MuscleVolume { muscle: string; label: string; group: string; sets: number; }

/** Trailing-window fractional set volume per muscle, summed across all logged sets. */
export async function getWeeklyVolume(days = 7): Promise<{ days: number; volumes: MuscleVolume[] }> {
  const sb = getClient();
  const since = toEastern(new Date(Date.now() - days * 86400000)).slice(0, 10);
  const { data: sessions } = await sb.from('workout_sessions').select('id').gte('date', since);
  const sessionIds = (sessions ?? []).map(s => s.id);
  const empty = MUSCLE_GROUPS.flatMap(g => g.muscles.map(m => ({ muscle: m.slug, label: m.label, group: g.group, sets: 0 })));
  if (!sessionIds.length) return { days, volumes: empty };

  const { data: exRows } = await sb.from('exercises').select('id, name').in('session_id', sessionIds);
  if (!exRows?.length) return { days, volumes: empty };
  const exIds = exRows.map(e => e.id);

  const { data: setRows } = await sb.from('exercise_sets').select('exercise_id').in('exercise_id', exIds);
  const setCount = new Map<string, number>();
  for (const s of (setRows ?? [])) setCount.set(s.exercise_id, (setCount.get(s.exercise_id) ?? 0) + 1);

  const { data: muscleRows } = await sb.from('exercise_muscles').select('name, muscle, contribution');
  const mapByName = new Map<string, { muscle: string; contribution: number }[]>();
  for (const m of (muscleRows ?? [])) {
    if (!mapByName.has(m.name)) mapByName.set(m.name, []);
    mapByName.get(m.name)!.push({ muscle: m.muscle, contribution: m.contribution });
  }

  const totals = new Map<string, number>();
  for (const ex of exRows) {
    const sets = setCount.get(ex.id) ?? 0;
    if (!sets) continue;
    for (const mm of (mapByName.get(ex.name) ?? []))
      totals.set(mm.muscle, (totals.get(mm.muscle) ?? 0) + mm.contribution * sets);
  }

  const volumes = MUSCLE_GROUPS.flatMap(g => g.muscles.map(m => ({
    muscle: m.slug, label: m.label, group: g.group,
    sets: Math.round((totals.get(m.slug) ?? 0) * 10) / 10,
  })));
  return { days, volumes };
}

/** Format the weekly volume as a grouped markdown report. Target band: ~10–20 hard sets/muscle/week. */
export function formatWeeklyVolume(result: { days: number; volumes: MuscleVolume[] }): string {
  const status = (s: number) => s === 0 ? '▫️ none' : s < 10 ? '⚠️ below' : s <= 20 ? '✅' : '🔺 high';
  const lines = [`**Weekly volume** — trailing ${result.days} days, fractional sets (target ~10–20 / muscle)`];
  let lastGroup = '';
  for (const v of result.volumes) {
    if (v.group !== lastGroup) { lines.push('', `_${v.group}_`); lastGroup = v.group; }
    lines.push(`  ${v.label.padEnd(20)} ${String(v.sets).padStart(4)}  ${status(v.sets)}`);
  }
  lines.push('', '_Smaller muscles (calves, arms, delts) tolerate the upper end; legs/back the middle._');
  return lines.join('\n');
}

export async function startWorkout(notes?: string): Promise<WorkoutSession> {
  const id = uuid();
  const d = now();
  await getClient().from('workout_sessions').insert({ id, date: d, notes: notes || '' });
  return { id, date: d, notes: notes || '', categories: [], exercises: [] };
}

export async function logExercise(sessionId: string, exercises: { name: string; categories?: string[]; sets: { weight_lbs: number; reps: number }[]; muscles?: Record<string, number> }[]): Promise<WorkoutSession | null> {
  const id = await resolveSessionId(sessionId);
  if (!id) return null;
  const sb = getClient();

  // Resolve every exercise against the canonical catalog up front — reject the
  // whole call if any is unknown and lacks a muscle map. Known exercises inherit
  // their canonical name + categories; genuinely new ones are registered.
  const prepared: { name: string; categories: string[]; sets: { weight_lbs: number; reps: number }[] }[] = [];
  for (const ex of exercises) {
    const entry = await lookupCatalog(ex.name);
    if (entry) {
      prepared.push({ name: entry.name, categories: entry.categories, sets: ex.sets });
    } else if (ex.muscles && Object.keys(ex.muscles).length) {
      const categories = validateCategories(ex.categories);
      const muscles = validateMuscles(ex.muscles);
      await registerCatalogEntry(ex.name.trim(), categories, muscles);
      prepared.push({ name: ex.name.trim(), categories, sets: ex.sets });
    } else {
      throw new Error(`Unknown exercise '${ex.name}'. Call get_workout_catalog and reuse the exact existing name if this movement already exists. If it is genuinely new, resend it with categories and a muscles map (e.g. {"quads":1.0,"glutes":0.5}).`);
    }
  }

  const { data: maxOrderRow } = await sb.from('exercises').select('sort_order')
    .eq('session_id', id).order('sort_order', { ascending: false }).limit(1).maybeSingle();
  let order = (maxOrderRow?.sort_order ?? -1) + 1;

  for (const ex of prepared) {
    const { data: existing } = await sb.from('exercises').select('id')
      .eq('session_id', id).ilike('name', ex.name.trim()).maybeSingle();

    let exId: string;
    if (existing) {
      exId = existing.id;
      const { data: maxSet } = await sb.from('exercise_sets').select('set_num')
        .eq('exercise_id', exId).order('set_num', { ascending: false }).limit(1).maybeSingle();
      const base = maxSet?.set_num ?? 0;
      for (let i = 0; i < ex.sets.length; i++) {
        await sb.from('exercise_sets').insert({ exercise_id: exId, set_num: base + i + 1, weight_lbs: ex.sets[i].weight_lbs, reps: ex.sets[i].reps });
      }
    } else {
      exId = uuid();
      await sb.from('exercises').insert({ id: exId, session_id: id, name: ex.name.trim(), categories: ex.categories, sort_order: order++ });
      for (let i = 0; i < ex.sets.length; i++) {
        await sb.from('exercise_sets').insert({ exercise_id: exId, set_num: i + 1, weight_lbs: ex.sets[i].weight_lbs, reps: ex.sets[i].reps });
      }
    }
  }
  return getWorkout(id);
}

export async function addSet(sessionId: string, name: string, weightLbs: number, reps: number): Promise<WorkoutSession | null> {
  const sid = await resolveSessionId(sessionId);
  if (!sid) return null;
  const sb = getClient();

  let { data: exercise } = await sb.from('exercises').select('id')
    .eq('session_id', sid).ilike('name', name).maybeSingle();

  if (!exercise) {
    // Creating a new exercise here: resolve it against the canonical catalog so it
    // inherits the canonical name + categories (and thus its muscle map). A movement
    // not in the catalog must go through log_exercise, which can register its muscles.
    const entry = await lookupCatalog(name);
    if (!entry) throw new Error(`Unknown exercise '${name}'. Call get_workout_catalog and reuse the exact existing name. If it is genuinely new, add it via log_exercise with a muscles map first.`);
    const { data: maxOrderRow } = await sb.from('exercises').select('sort_order')
      .eq('session_id', sid).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const exId = uuid();
    await sb.from('exercises').insert({ id: exId, session_id: sid, name: entry.name, categories: entry.categories, sort_order: (maxOrderRow?.sort_order ?? -1) + 1 });
    exercise = { id: exId };
  }

  const { data: maxSet } = await sb.from('exercise_sets').select('set_num')
    .eq('exercise_id', exercise.id).order('set_num', { ascending: false }).limit(1).maybeSingle();
  const setNum = (maxSet?.set_num ?? 0) + 1;
  await sb.from('exercise_sets').insert({ exercise_id: exercise.id, set_num: setNum, weight_lbs: weightLbs, reps });
  return getWorkout(sid);
}

export async function updateExercise(sessionId: string, name: string, sets: { weight_lbs: number; reps: number }[]): Promise<WorkoutSession | null> {
  const sid = await resolveSessionId(sessionId);
  if (!sid) return null;
  const sb = getClient();
  const { data: exercise } = await sb.from('exercises').select('id')
    .eq('session_id', sid).ilike('name', name).maybeSingle();
  if (!exercise) return null;
  await sb.from('exercise_sets').delete().eq('exercise_id', exercise.id);
  for (let i = 0; i < sets.length; i++) {
    await sb.from('exercise_sets').insert({ exercise_id: exercise.id, set_num: i + 1, weight_lbs: sets[i].weight_lbs, reps: sets[i].reps });
  }
  return getWorkout(sid);
}

export async function removeExercise(sessionId: string, name: string): Promise<{ removed: string; session: WorkoutSession } | null> {
  const sid = await resolveSessionId(sessionId);
  if (!sid) return null;
  const sb = getClient();
  const { data: exercise } = await sb.from('exercises').select('id, name')
    .eq('session_id', sid).ilike('name', name).maybeSingle();
  if (!exercise) return null;
  await sb.from('exercises').delete().eq('id', exercise.id);
  return { removed: exercise.name, session: (await getWorkout(sid))! };
}

export async function deleteWorkout(sessionId: string): Promise<WorkoutSession | null> {
  const sid = await resolveSessionId(sessionId);
  if (!sid) return null;
  const session = await getWorkout(sid);
  if (!session) return null;
  await getClient().from('workout_sessions').delete().eq('id', sid);
  return session;
}

export async function updateSessionNotes(sessionId: string, notes: string): Promise<WorkoutSession | null> {
  const sid = await resolveSessionId(sessionId);
  if (!sid) return null;
  await getClient().from('workout_sessions').update({ notes }).eq('id', sid);
  return getWorkout(sid);
}

async function resolveSessionId(prefix: string): Promise<string | null> {
  const sb = getClient();
  const { data: exact } = await sb.from('workout_sessions').select('id').eq('id', prefix).maybeSingle();
  if (exact) return exact.id;
  const { data: matches } = await sb.from('workout_sessions').select('id').like('id', `${prefix}%`);
  if (matches?.length === 1) return matches[0].id;
  return null;
}

export function formatSessionTable(session: WorkoutSession): string {
  const lines = [
    `**${categoryLabel(session.categories)} session** (${session.date.slice(0, 10)})  \`${session.id.slice(0, 8)}\``,
    '', '| Exercise | Sets | Reps | Weight |', '|---|---|---|---|',
  ];
  for (const ex of session.exercises) {
    if (!ex.sets.length) { lines.push(`| ${ex.name} | 0 | — | — |`); continue; }
    const n = ex.sets.length;
    const repsList = ex.sets.map(s => s.reps);
    const weights = ex.sets.map(s => s.weight_lbs);
    const repsStr = new Set(repsList).size === 1 ? String(repsList[0]) : repsList.join(', ');
    const weightStr = new Set(weights).size === 1 ? fmtWeight(weights[0]) : weights.map(fmtWeight).join(', ');
    lines.push(`| ${ex.name} | ${n} | ${repsStr} | ${weightStr} |`);
  }
  return lines.join('\n');
}

export function formatWorkoutDetail(session: WorkoutSession): string {
  const lines = [`Session: ${session.id.slice(0, 8)}`, `Categories: ${session.categories.join(', ') || 'untyped'}`, `Date: ${session.date}`];
  if (session.notes) lines.push(`Notes: ${session.notes}`);
  lines.push('');
  for (const ex of session.exercises) {
    lines.push(`  ${ex.name} [${ex.categories.join(', ')}]:`);
    for (const s of ex.sets) lines.push(`    Set ${s.set_num}: ${s.weight_lbs} lbs x ${s.reps} reps`);
  }
  return lines.join('\n');
}
