import type Database from 'better-sqlite3';
import { now, uuid } from './helpers.js';

export interface Reminder {
  id: string;
  text: string;
  due: string | null;
  done: boolean;
  deleted: boolean;
  created: string;
  updated: string;
}

function rowToReminder(row: any): Reminder {
  return { ...row, done: !!row.done, deleted: !!row.deleted };
}

export function listReminders(db: Database.Database): Reminder[] {
  return (db.prepare('SELECT * FROM reminders WHERE deleted = 0 ORDER BY created').all() as any[]).map(rowToReminder);
}

export function addReminder(db: Database.Database, text: string, due?: string): Reminder {
  const n = now();
  const id = uuid();
  db.prepare('INSERT INTO reminders (id, text, due, done, deleted, created, updated) VALUES (?, ?, ?, 0, 0, ?, ?)').run(id, text, due || null, n, n);
  return { id, text, due: due || null, done: false, deleted: false, created: n, updated: n };
}

export function completeReminder(db: Database.Database, idPrefix: string): Reminder | null {
  const id = resolveReminderId(db, idPrefix);
  if (!id) return null;
  const n = now();
  db.prepare('UPDATE reminders SET done = 1, updated = ? WHERE id = ?').run(n, id);
  return rowToReminder(db.prepare('SELECT * FROM reminders WHERE id = ?').get(id));
}

export function removeReminder(db: Database.Database, idPrefix: string): Reminder | null {
  const id = resolveReminderId(db, idPrefix);
  if (!id) return null;
  const n = now();
  db.prepare('UPDATE reminders SET deleted = 1, updated = ? WHERE id = ?').run(n, id);
  return rowToReminder(db.prepare('SELECT * FROM reminders WHERE id = ?').get(id));
}

function resolveReminderId(db: Database.Database, prefix: string): string | null {
  const exact = db.prepare('SELECT id FROM reminders WHERE id = ? AND deleted = 0').get(prefix) as { id: string } | undefined;
  if (exact) return exact.id;
  const matches = db.prepare("SELECT id FROM reminders WHERE deleted = 0 AND id LIKE ? || '%'").all(prefix) as { id: string }[];
  if (matches.length === 1) return matches[0].id;
  return null;
}

export function formatReminders(items: Reminder[]): string {
  const active = items.filter(i => !i.deleted);
  if (!active.length) return 'No active reminders.';
  const lines = active.map(i => {
    const check = i.done ? '[x]' : '[ ]';
    const due = i.due ? ` (due: ${i.due})` : '';
    return `${check} ${i.text}${due}  [id: ${i.id.slice(0, 8)}]`;
  });
  return `**Reminders** (${active.length} items):\n${lines.join('\n')}`;
}
