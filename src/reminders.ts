import { getClient } from './client.js';
import { now, uuid } from './helpers.js';

// There is ONE way for a reminder to leave the list: `deleted`. There is no separate "done" state —
// checking something off and getting rid of it are the same act, so modelling them apart only created
// two flags that had to be kept in sync and two surfaces that disagreed about what a tick meant.
// `deleted` is soft: the row stays for a recovery window and is purged later, so nothing is lost.
export interface Reminder {
  id: string; text: string; due: string | null;
  deleted: boolean; created: string; updated: string;
}

export async function listReminders(): Promise<Reminder[]> {
  const { data } = await getClient().from('reminders').select('*').eq('deleted', false).order('created');
  return (data ?? []) as Reminder[];
}

export async function addReminder(text: string, due?: string): Promise<Reminder> {
  const n = now(); const id = uuid();
  const { data } = await getClient().from('reminders')
    .insert({ id, text, due: due || null, deleted: false, created: n, updated: n })
    .select().single();
  return data as Reminder;
}

/** Clear a reminder — checking it off and deleting it are the same thing. Soft, so it's recoverable. */
export async function removeReminder(idPrefix: string): Promise<Reminder | null> {
  const id = await resolveReminderId(idPrefix);
  if (!id) return null;
  const n = now();
  await getClient().from('reminders').update({ deleted: true, updated: n }).eq('id', id);
  const { data } = await getClient().from('reminders').select('*').eq('id', id).single();
  return data as Reminder;
}

async function resolveReminderId(prefix: string): Promise<string | null> {
  const { data: exact } = await getClient().from('reminders').select('id')
    .eq('id', prefix).eq('deleted', false).maybeSingle();
  if (exact) return exact.id;
  const { data: matches } = await getClient().from('reminders').select('id')
    .eq('deleted', false).like('id', `${prefix}%`);
  if (matches?.length === 1) return matches[0].id;
  return null;
}

export function formatReminders(items: Reminder[]): string {
  const active = items.filter(i => !i.deleted);
  if (!active.length) return 'No active reminders.';
  const lines = active.map(i => {
    const due = i.due ? ` (due: ${i.due})` : '';
    return `- ${i.text}${due}  [id: ${i.id.slice(0, 8)}]`;
  });
  return `**Reminders** (${active.length} items):\n${lines.join('\n')}`;
}
