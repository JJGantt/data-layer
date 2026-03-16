import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export function now(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/New_York', hour12: false }).replace(' ', 'T');
}

export function uuid(): string {
  return randomUUID();
}

export function today(): string {
  return now().slice(0, 10);
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
