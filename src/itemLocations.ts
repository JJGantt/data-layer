// Where untracked things are kept — a passport, a charger: an item name and a free-text location.
// One row per item (table item_locations, 00185); setting an item that exists replaces its location.
// Items are matched case-insensitively by the table's generated `key`, nothing fuzzier: the whole list
// is small enough for the model to read and pick the exact name, so a near miss is visible instead of
// silently matched.

import { createHash } from 'node:crypto';
import { getClient } from './client.js';
import { now, ValidationError } from './helpers.js';

export type ItemLocation = { item: string; location: string; updated_at: string };

const keyOf = (item: string) => item.trim().toLowerCase();

/** A fingerprint of which items exist. get_item_locations hands it out and set() demands it back, so a
 *  write is only accepted from a caller that has seen every saved name — the read is what stops
 *  'my passport' becoming a second entry beside 'passport', so it is enforced, not just asked for.
 *  Names only: a location changing elsewhere does not invalidate it, a new or removed item does. */
export function rosterToken(rows: ItemLocation[]): string {
  const names = rows.map(r => keyOf(r.item)).sort().join('\n');
  return createHash('sha256').update(names).digest('hex').slice(0, 8);
}

export async function all(): Promise<ItemLocation[]> {
  const { data, error } = await getClient().from('item_locations')
    .select('item,location,updated_at').order('item');
  if (error) throw new Error(error.message);
  return (data || []) as ItemLocation[];
}

/** Set an item's location; returns the row and what it was before (null for a new item). */
export async function set(item: string, location: string, seen: string): Promise<{ row: ItemLocation; previous: ItemLocation | null }> {
  item = String(item ?? '').trim();
  location = String(location ?? '').trim();
  if (!item) throw new ValidationError('item is required');
  if (!location) throw new ValidationError('location is required');
  const existing = await all();
  if (String(seen ?? '').trim() !== rosterToken(existing)) {
    // A refusal the model corrects on its next call: a ValidationError, counted rather than raised.
    throw new ValidationError(`Not saved: ${seen ? 'the saved items have changed since that list was read' : 'no \`seen\` token'}. ` +
      `Here is everything saved now — if "${item}" is one of these under another name, use that exact name; ` +
      `otherwise it is new. Call again with seen="${rosterToken(existing)}".\n${format(existing)}`);
  }
  const previous = existing.find(r => keyOf(r.item) === keyOf(item)) ?? null;
  const { data, error } = await getClient().from('item_locations')
    .upsert({ item, location, updated_at: now() }, { onConflict: 'key' })
    .select('item,location,updated_at').single();
  if (error) throw new Error(error.message);
  return { row: data as ItemLocation, previous };
}

export async function remove(item: string): Promise<ItemLocation | null> {
  const { data, error } = await getClient().from('item_locations')
    .delete().eq('key', keyOf(String(item ?? ''))).select('item,location,updated_at');
  if (error) throw new Error(error.message);
  return (data?.[0] as ItemLocation) ?? null;
}

export function format(rows: ItemLocation[]): string {
  if (!rows.length) return 'No item locations saved yet.';
  return rows.map(r => `- ${r.item}: ${r.location} (since ${r.updated_at.slice(0, 16).replace('T', ' ')})`).join('\n');
}
