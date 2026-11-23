// Where untracked things are kept — a passport, a charger: an item name and a free-text location.
// One row per item (table item_locations, 00185); setting an item that exists replaces its location.
// Items are matched case-insensitively by the table's generated `key`, nothing fuzzier: the whole list
// is small enough for the model to read and pick the exact name, so a near miss is visible instead of
// silently matched.

import { getClient } from './client.js';
import { now } from './helpers.js';

export type ItemLocation = { item: string; location: string; updated_at: string };

const keyOf = (item: string) => item.trim().toLowerCase();

export async function all(): Promise<ItemLocation[]> {
  const { data, error } = await getClient().from('item_locations')
    .select('item,location,updated_at').order('item');
  if (error) throw new Error(error.message);
  return (data || []) as ItemLocation[];
}

/** Set an item's location; returns the row and what it was before (null for a new item). */
export async function set(item: string, location: string): Promise<{ row: ItemLocation; previous: ItemLocation | null; others: string[] }> {
  item = String(item ?? '').trim();
  location = String(location ?? '').trim();
  if (!item) throw new Error('item is required');
  if (!location) throw new Error('location is required');
  const existing = await all();
  const previous = existing.find(r => keyOf(r.item) === keyOf(item)) ?? null;
  const { data, error } = await getClient().from('item_locations')
    .upsert({ item, location, updated_at: now() }, { onConflict: 'key' })
    .select('item,location,updated_at').single();
  if (error) throw new Error(error.message);
  return { row: data as ItemLocation, previous, others: existing.filter(r => r !== previous).map(r => r.item) };
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
