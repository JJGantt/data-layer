import { getClient } from './client.js';
import { now } from './helpers.js';

export interface Note { name: string; content: string; updated: string; }

export async function availableNotes(): Promise<string[]> {
  const { data } = await getClient().from('notes').select('name').order('name');
  return (data ?? []).map(r => r.name);
}

export async function getNote(name: string): Promise<Note | null> {
  const { data } = await getClient().from('notes').select('*').eq('name', name).maybeSingle();
  return data as Note | null;
}

export async function setNote(name: string, content: string): Promise<void> {
  const n = now();
  await getClient().from('notes').upsert({ name, content, updated: n }, { onConflict: 'name' });
}

export async function allNotes(): Promise<Note[]> {
  const { data } = await getClient().from('notes').select('*').order('name');
  return (data ?? []) as Note[];
}

// Delete a note by name (case-insensitive). Returns the stored name deleted, or null if none matched.
export async function deleteNote(name: string): Promise<string | null> {
  const want = String(name || '').trim();
  const { data } = await getClient().from('notes').select('name');
  const hit = (data ?? []).find(r => String(r.name).toLowerCase() === want.toLowerCase());
  if (!hit) return null;
  await getClient().from('notes').delete().eq('name', hit.name);
  return String(hit.name);
}
