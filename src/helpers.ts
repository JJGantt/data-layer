import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export function now(): string {
  return toEastern(new Date());
}

/** Convert a Date to Eastern time string (yyyy-MM-ddTHH:mm:ss). */
export function toEastern(d: Date): string {
  return d.toLocaleString('sv-SE', { timeZone: 'America/New_York', hour12: false }).replace(' ', 'T');
}

/**
 * Ensure a date string is in Eastern time.
 * If it looks like an ISO string with Z or +00:00, parse as UTC and convert.
 * If it has no timezone indicator, parse as UTC and convert (since Claude tends to give UTC).
 * For date-only strings (yyyy-MM-dd), return as-is.
 */
export function ensureEastern(dateStr: string): string {
  // Date-only: nothing to convert
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  // Parse and convert — Date() treats strings without Z as local, so append Z
  // to force UTC interpretation, since Claude typically sends UTC
  const hasTimezone = /[Zz]|[+-]\d{2}:\d{2}$/.test(dateStr);
  const d = new Date(hasTimezone ? dateStr : dateStr + 'Z');
  if (isNaN(d.getTime())) return dateStr;
  return toEastern(d);
}

export function uuid(): string {
  return randomUUID();
}

export function today(): string {
  return now().slice(0, 10);
}

/** Like ensureEastern but returns only the date portion (yyyy-MM-dd). */
export function ensureEasternDate(dateStr: string): string {
  return ensureEastern(dateStr).slice(0, 10);
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
