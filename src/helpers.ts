import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '').replace('Z', '');
}

export function uuid(): string {
  return randomUUID();
}

export function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Resolve an ID by full match or unique prefix. */
export function resolveId(db: Database.Database, table: string, prefix: string): string | null {
  // Try exact match first
  const exact = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(prefix) as { id: string } | undefined;
  if (exact) return exact.id;
  // Try prefix
  const matches = db.prepare(`SELECT id FROM ${table} WHERE id LIKE ? || '%'`).all(prefix) as { id: string }[];
  if (matches.length === 1) return matches[0].id;
  return null;
}

export function fmtWeight(w: number): string {
  if (w === 0) return 'BW';
  return `${w === Math.floor(w) ? Math.floor(w) : w} lbs`;
}
