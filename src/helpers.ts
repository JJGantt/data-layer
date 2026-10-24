import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

// READ THIS BEFORE ASSUMING now() IS THE CURRENT TIME — IT OFTEN ISN'T.
// Under the voice worker, now() returns THE MOMENT THE USER STARTED SPEAKING, not the current instant:
// voice-pipeline's worker.py writes the command's audio-recording start (voice_requests.capture_start)
// to the file named by DATA_TS_FILE, and now() reads it per call. Deliberate — a
// set logged by voice has to land at Jared's rest-clock reference, not ~30s later when the command
// finishes traversing transcription + routing + the model. Every caller below inherits that: `today()`
// is the day he spoke, and anything stamped with now() is voice-aware whether or not it says so.
// No file, or an empty one (typed/web commands, direct API callers, no command in flight) → the real
// machine clock: pure wall clock, no timezone concept at all, whatever this host reads right now.
// The worker rewrites the file at the START of every command — the capture_start for audio, empty for
// typed/web — so the value can never be a previous turn's. Nothing writes between turns: this MCP runs
// only when the model calls a tool.
// (Named toEastern/now for historical reasons — it used to force America/New_York regardless of where
// the host actually was; that was the bug. nutrition.ts used to keep its own clock helper that skipped
// the override, so voice-logged food stamped ~30s late; it now calls this, so every table agrees.)
export function now(): string {
  // The per-command timestamp arrives in a FILE, and the env var names its path. It cannot be the
  // value itself: the voice worker's fast path keeps MCP servers as warm stdio sessions started once
  // per worker lifetime, so a value baked into this process's environment at spawn freezes there for
  // as long as the worker runs — which stamped 29 hours of voice-logged writes with one moment before
  // it was caught. A path is constant for the process while its contents are re-read every call, so
  // the session stays warm and the timestamp stays current.
  const f = process.env.DATA_TS_FILE;
  if (f) {
    try {
      const v = readFileSync(f, 'utf8').trim();
      if (v && !isNaN(new Date(v).getTime())) return ensureEastern(v);
    } catch { /* no command in flight, or the file was cleared — fall through to the real clock */ }
  }
  return toEastern(new Date());
}

/** Format a Date as this machine's own local wall-clock reading (yyyy-MM-ddTHH:mm:ss). */
export function toEastern(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Reduce a date string the model gave us to this machine's own wall-clock format.
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

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export interface MacroNutritionInput {
  calories?: number | null;
  protein_g?: number | null;
  carbs_g?: number | null;
  fat_g?: number | null;
}

export interface MacroNutrition {
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
}

function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatFieldList(fields: string[]): string {
  if (fields.length === 1) return fields[0];
  if (fields.length === 2) return `${fields[0]} and ${fields[1]}`;
  return `${fields.slice(0, -1).join(', ')}, and ${fields[fields.length - 1]}`;
}

export function deriveCaloriesFromMacros(protein_g: number, carbs_g: number, fat_g: number): number {
  return Math.round((protein_g * 4) + (carbs_g * 4) + (fat_g * 9));
}

export function normalizeMacroNutrition(nutrition: MacroNutritionInput | null | undefined, context: string): MacroNutrition {
  const macroFields = ['protein_g', 'carbs_g', 'fat_g'] as const;
  const missing = macroFields.filter((field) => !isFiniteNumber(nutrition?.[field]));
  if (missing.length) {
    throw new ValidationError(`${context} requires numeric ${formatFieldList([...missing])}.`);
  }

  const negative = macroFields.filter((field) => (nutrition?.[field] as number) < 0);
  if (negative.length) {
    throw new ValidationError(`${context} requires non-negative ${formatFieldList([...negative])}.`);
  }

  const protein_g = roundTenth(nutrition!.protein_g as number);
  const carbs_g = roundTenth(nutrition!.carbs_g as number);
  const fat_g = roundTenth(nutrition!.fat_g as number);

  let calories: number;
  if (nutrition?.calories == null) {
    calories = deriveCaloriesFromMacros(protein_g, carbs_g, fat_g);
  } else if (!isFiniteNumber(nutrition.calories)) {
    throw new ValidationError(`${context} requires numeric calories when calories are provided.`);
  } else if (nutrition.calories < 0) {
    throw new ValidationError(`${context} requires non-negative calories.`);
  } else {
    calories = roundTenth(nutrition.calories);
  }

  return { calories, protein_g, carbs_g, fat_g };
}

export function fmtWeight(w: number): string {
  if (w === 0) return 'BW';
  return `${w === Math.floor(w) ? Math.floor(w) : w} lbs`;
}
