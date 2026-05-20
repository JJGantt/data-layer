import { getClient } from './client.js';
import { now, uuid, fmtWeight } from './helpers.js';

export interface WorkoutSet { set_num: number; weight_lbs: number; reps: number; }
export interface Exercise { id: string; name: string; sets: WorkoutSet[]; }
export interface WorkoutSession { id: string; date: string; type: string; notes: string; exercises: Exercise[]; }
export interface WorkoutSummary { id: string; date: string; type: string; exerciseCount: number; notes: string; }

async function loadExercises(sessionId: string): Promise<Exercise[]> {
  const sb = getClient();
  const { data: exRows } = await sb.from('exercises').select('id, name')
    .eq('session_id', sessionId).order('sort_order');
  if (!exRows?.length) return [];
  const exercises: Exercise[] = [];
  for (const ex of exRows) {
    const { data: sets } = await sb.from('exercise_sets').select('set_num, weight_lbs, reps')
      .eq('exercise_id', ex.id).order('set_num');
    exercises.push({ id: ex.id, name: ex.name, sets: (sets ?? []) as WorkoutSet[] });
  }
  return exercises;
}

export async function getWorkout(idPrefix: string): Promise<WorkoutSession | null> {
  const id = await resolveSessionId(idPrefix);
  if (!id) return null;
  const { data: row } = await getClient().from('workout_sessions').select('*').eq('id', id).maybeSingle();
  if (!row) return null;
  return { ...row, exercises: await loadExercises(row.id) };
}

export async function listWorkouts(limit = 10): Promise<WorkoutSummary[]> {
  const sb = getClient();
  const { data: rows } = await sb.from('workout_sessions').select('id, date, type, notes')
    .order('date', { ascending: false }).limit(limit);
  if (!rows?.length) return [];
  const summaries: WorkoutSummary[] = [];
  for (const r of rows) {
    const { count } = await sb.from('exercises').select('*', { count: 'exact', head: true }).eq('session_id', r.id);
    summaries.push({ id: r.id, date: r.date, type: r.type, notes: r.notes, exerciseCount: count ?? 0 });
  }
  return summaries;
}

export async function getCatalog(): Promise<{ types: string[]; exercises: string[] }> {
  const sb = getClient();
  const { data: typeRows } = await sb.from('workout_sessions').select('type');
  const { data: exRows } = await sb.from('exercises').select('name');
  const types = [...new Set((typeRows ?? []).map(r => r.type))].sort();
  const exercises = [...new Set((exRows ?? []).map(r => r.name))].sort();
  return { types, exercises };
}

export async function getExerciseHistory(name: string, limit = 20): Promise<{ date: string; session_id: string; session_type: string; sets: WorkoutSet[] }[]> {
  const sb = getClient();
  const { data: exRows } = await sb.from('exercises').select('id, name, session_id, workout_sessions(id, date, type)')
    .ilike('name', name).order('session_id', { ascending: false }).limit(limit);
  if (!exRows?.length) return [];
  const results: { date: string; session_id: string; session_type: string; sets: WorkoutSet[] }[] = [];
  for (const ex of exRows) {
    const session = ex.workout_sessions as any;
    if (!session) continue;
    const { data: sets } = await sb.from('exercise_sets').select('set_num, weight_lbs, reps')
      .eq('exercise_id', ex.id).order('set_num');
    results.push({
      date: session.date.slice(0, 10),
      session_id: session.id.slice(0, 8),
      session_type: session.type,
      sets: (sets ?? []) as WorkoutSet[],
    });
  }
  // Sort by date desc
  results.sort((a, b) => b.date.localeCompare(a.date));
  return results.slice(0, limit);
}

export async function startWorkout(type: string, notes?: string): Promise<WorkoutSession> {
  const id = uuid();
  const d = now();
  await getClient().from('workout_sessions').insert({ id, date: d, type, notes: notes || '' });
  return { id, date: d, type, notes: notes || '', exercises: [] };
}

export async function logExercise(sessionId: string, exercises: { name: string; sets: { weight_lbs: number; reps: number }[] }[]): Promise<WorkoutSession | null> {
  const id = await resolveSessionId(sessionId);
  if (!id) return null;
  const sb = getClient();

  const { data: maxOrderRow } = await sb.from('exercises').select('sort_order')
    .eq('session_id', id).order('sort_order', { ascending: false }).limit(1).maybeSingle();
  let order = (maxOrderRow?.sort_order ?? -1) + 1;

  for (const ex of exercises) {
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
      await sb.from('exercises').insert({ id: exId, session_id: id, name: ex.name.trim(), sort_order: order++ });
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
    const { data: maxOrderRow } = await sb.from('exercises').select('sort_order')
      .eq('session_id', sid).order('sort_order', { ascending: false }).limit(1).maybeSingle();
    const exId = uuid();
    await sb.from('exercises').insert({ id: exId, session_id: sid, name: name.trim(), sort_order: (maxOrderRow?.sort_order ?? -1) + 1 });
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
    `**${session.type.charAt(0).toUpperCase() + session.type.slice(1)} session** (${session.date.slice(0, 10)})  \`${session.id.slice(0, 8)}\``,
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
  const lines = [`Session: ${session.id.slice(0, 8)}`, `Type: ${session.type}`, `Date: ${session.date}`];
  if (session.notes) lines.push(`Notes: ${session.notes}`);
  lines.push('');
  for (const ex of session.exercises) {
    lines.push(`  ${ex.name}:`);
    for (const s of ex.sets) lines.push(`    Set ${s.set_num}: ${s.weight_lbs} lbs x ${s.reps} reps`);
  }
  return lines.join('\n');
}
