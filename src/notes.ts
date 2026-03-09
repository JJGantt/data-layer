import type Database from 'better-sqlite3';
import { now } from './helpers.js';

export interface Note {
  name: string;
  content: string;
  updated: string;
}

export function availableNotes(db: Database.Database): string[] {
  return (db.prepare('SELECT name FROM notes ORDER BY name').all() as { name: string }[]).map(r => r.name);
}

export function getNote(db: Database.Database, name: string): Note | null {
  return db.prepare('SELECT * FROM notes WHERE name = ?').get(name) as Note | undefined ?? null;
}

export function setNote(db: Database.Database, name: string, content: string): void {
  const n = now();
  db.prepare(`
    INSERT INTO notes (name, content, updated) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated = excluded.updated
  `).run(name, content, n);
}

export function allNotes(db: Database.Database): Note[] {
  return db.prepare('SELECT * FROM notes ORDER BY name').all() as Note[];
}
