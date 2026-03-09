import type Database from 'better-sqlite3';
import { now, uuid, fmtWeight } from './helpers.js';

export interface WorkoutSet {
  set_num: number;
  weight_lbs: number;
  reps: number;
}

export interface Exercise {
  id: string;
  name: string;
  sets: WorkoutSet[];
}

export interface WorkoutSession {
  id: string;
  date: string;
  type: string;
  notes: string;
  exercises: Exercise[];
}

export interface WorkoutSummary {
  id: string;
  date: string;
  type: string;
  exerciseCount: number;
  notes: string;
}

// ── Reads ──────────────────────────────────────────────────────────────────

function loadExercises(db: Database.Database, sessionId: string): Exercise[] {
  const rows = db.prepare('SELECT id, name FROM exercises WHERE session_id = ? ORDER BY sort_order').all(sessionId) as { id: string; name: string }[];
  return rows.map(ex => {
    const sets = db.prepare('SELECT set_num, weight_lbs, reps FROM exercise_sets WHERE exercise_id = ? ORDER BY set_num').all(ex.id) as WorkoutSet[];
    return { id: ex.id, name: ex.name, sets };
  });
}

export function getWorkout(db: Database.Database, idPrefix: string): WorkoutSession | null {
  const id = resolveSessionId(db, idPrefix);
  if (!id) return null;
  const row = db.prepare('SELECT * FROM workout_sessions WHERE id = ?').get(id) as any;
  if (!row) return null;
  return { ...row, exercises: loadExercises(db, row.id) };
}

export function listWorkouts(db: Database.Database, limit = 10): WorkoutSummary[] {
  const rows = db.prepare('SELECT id, date, type, notes FROM workout_sessions ORDER BY date DESC LIMIT ?').all(limit) as any[];
  return rows.map(r => ({
    id: r.id,
    date: r.date,
    type: r.type,
    notes: r.notes,
    exerciseCount: (db.prepare('SELECT COUNT(*) as c FROM exercises WHERE session_id = ?').get(r.id) as any).c,
  }));
}

export function getCatalog(db: Database.Database): { types: string[]; exercises: string[] } {
  const types = (db.prepare('SELECT DISTINCT type FROM workout_sessions ORDER BY type').all() as { type: string }[]).map(r => r.type);
  const exercises = (db.prepare('SELECT DISTINCT name FROM exercises ORDER BY name').all() as { name: string }[]).map(r => r.name);
  return { types, exercises };
}

export function getExerciseHistory(db: Database.Database, name: string, limit = 20): { date: string; session_id: string; session_type: string; sets: WorkoutSet[] }[] {
  const rows = db.prepare(`
    SELECT e.id as eid, e.name, ws.id as sid, ws.date, ws.type
    FROM exercises e JOIN workout_sessions ws ON e.session_id = ws.id
    WHERE e.name = ? COLLATE NOCASE
    ORDER BY ws.date DESC LIMIT ?
  `).all(name, limit) as any[];
  return rows.map(r => ({
    date: r.date.slice(0, 10),
    session_id: r.sid.slice(0, 8),
    session_type: r.type,
    sets: db.prepare('SELECT set_num, weight_lbs, reps FROM exercise_sets WHERE exercise_id = ? ORDER BY set_num').all(r.eid) as WorkoutSet[],
  }));
}

// ── Writes ─────────────────────────────────────────────────────────────────

export function startWorkout(db: Database.Database, type: string, notes?: string, date?: string): WorkoutSession {
  const id = uuid();
  const d = date || now();
  db.prepare('INSERT INTO workout_sessions (id, date, type, notes) VALUES (?, ?, ?, ?)').run(id, d, type, notes || '');
  return { id, date: d, type, notes: notes || '', exercises: [] };
}

export function logExercise(db: Database.Database, sessionId: string, exercises: { name: string; sets: { weight_lbs: number; reps: number }[] }[]): WorkoutSession | null {
  const id = resolveSessionId(db, sessionId);
  if (!id) return null;

  const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM exercises WHERE session_id = ?').get(id) as any)?.m ?? -1;

  const insertEx = db.prepare('INSERT INTO exercises (id, session_id, name, sort_order) VALUES (?, ?, ?, ?)');
  const insertSet = db.prepare('INSERT INTO exercise_sets (exercise_id, set_num, weight_lbs, reps) VALUES (?, ?, ?, ?)');

  db.transaction(() => {
    let order = maxOrder + 1;
    for (const ex of exercises) {
      const exId = uuid();
      insertEx.run(exId, id, ex.name.trim(), order++);
      for (let i = 0; i < ex.sets.length; i++) {
        insertSet.run(exId, i + 1, ex.sets[i].weight_lbs, ex.sets[i].reps);
      }
    }
  })();

  return getWorkout(db, id);
}

export function addSet(db: Database.Database, sessionId: string, name: string, weightLbs: number, reps: number): WorkoutSession | null {
  const sid = resolveSessionId(db, sessionId);
  if (!sid) return null;

  // Find existing exercise by name (case-insensitive)
  let exercise = db.prepare('SELECT id FROM exercises WHERE session_id = ? AND name = ? COLLATE NOCASE').get(sid, name) as { id: string } | undefined;

  if (!exercise) {
    // Create the exercise
    const maxOrder = (db.prepare('SELECT MAX(sort_order) as m FROM exercises WHERE session_id = ?').get(sid) as any)?.m ?? -1;
    const exId = uuid();
    db.prepare('INSERT INTO exercises (id, session_id, name, sort_order) VALUES (?, ?, ?, ?)').run(exId, sid, name.trim(), maxOrder + 1);
    exercise = { id: exId };
  }

  const setNum = ((db.prepare('SELECT MAX(set_num) as m FROM exercise_sets WHERE exercise_id = ?').get(exercise.id) as any)?.m ?? 0) + 1;
  db.prepare('INSERT INTO exercise_sets (exercise_id, set_num, weight_lbs, reps) VALUES (?, ?, ?, ?)').run(exercise.id, setNum, weightLbs, reps);

  return getWorkout(db, sid);
}

export function updateExercise(db: Database.Database, sessionId: string, name: string, sets: { weight_lbs: number; reps: number }[]): WorkoutSession | null {
  const sid = resolveSessionId(db, sessionId);
  if (!sid) return null;

  const exercise = db.prepare('SELECT id FROM exercises WHERE session_id = ? AND name = ? COLLATE NOCASE').get(sid, name) as { id: string } | undefined;
  if (!exercise) return null;

  db.transaction(() => {
    db.prepare('DELETE FROM exercise_sets WHERE exercise_id = ?').run(exercise!.id);
    const insert = db.prepare('INSERT INTO exercise_sets (exercise_id, set_num, weight_lbs, reps) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < sets.length; i++) {
      insert.run(exercise!.id, i + 1, sets[i].weight_lbs, sets[i].reps);
    }
  })();

  return getWorkout(db, sid);
}

export function removeExercise(db: Database.Database, sessionId: string, name: string): { removed: string; session: WorkoutSession } | null {
  const sid = resolveSessionId(db, sessionId);
  if (!sid) return null;

  const exercise = db.prepare('SELECT id, name FROM exercises WHERE session_id = ? AND name = ? COLLATE NOCASE').get(sid, name) as { id: string; name: string } | undefined;
  if (!exercise) return null;

  db.prepare('DELETE FROM exercises WHERE id = ?').run(exercise.id);
  return { removed: exercise.name, session: getWorkout(db, sid)! };
}

export function deleteWorkout(db: Database.Database, sessionId: string): WorkoutSession | null {
  const sid = resolveSessionId(db, sessionId);
  if (!sid) return null;
  const session = getWorkout(db, sid);
  if (!session) return null;
  db.prepare('DELETE FROM workout_sessions WHERE id = ?').run(sid);
  return session;
}

export function updateSessionNotes(db: Database.Database, sessionId: string, notes: string): WorkoutSession | null {
  const sid = resolveSessionId(db, sessionId);
  if (!sid) return null;
  db.prepare('UPDATE workout_sessions SET notes = ? WHERE id = ?').run(notes, sid);
  return getWorkout(db, sid);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveSessionId(db: Database.Database, prefix: string): string | null {
  const exact = db.prepare('SELECT id FROM workout_sessions WHERE id = ?').get(prefix) as { id: string } | undefined;
  if (exact) return exact.id;
  const matches = db.prepare("SELECT id FROM workout_sessions WHERE id LIKE ? || '%'").all(prefix) as { id: string }[];
  if (matches.length === 1) return matches[0].id;
  return null;
}

// ── Formatting ─────────────────────────────────────────────────────────────

export function formatSessionTable(session: WorkoutSession): string {
  const lines = [
    `**${session.type.charAt(0).toUpperCase() + session.type.slice(1)} session** (${session.date.slice(0, 10)})  \`${session.id.slice(0, 8)}\``,
    '',
    '| Exercise | Sets | Reps | Weight |',
    '|---|---|---|---|',
  ];
  for (const ex of session.exercises) {
    if (!ex.sets.length) {
      lines.push(`| ${ex.name} | 0 | — | — |`);
      continue;
    }
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
  const lines = [
    `Session: ${session.id.slice(0, 8)}`,
    `Type: ${session.type}`,
    `Date: ${session.date}`,
  ];
  if (session.notes) lines.push(`Notes: ${session.notes}`);
  lines.push('');
  for (const ex of session.exercises) {
    lines.push(`  ${ex.name}:`);
    for (const s of ex.sets) {
      lines.push(`    Set ${s.set_num}: ${s.weight_lbs} lbs x ${s.reps} reps`);
    }
  }
  return lines.join('\n');
}
