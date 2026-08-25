import { getClient } from './client.js';
import { now, uuid } from './helpers.js';

// Lists hold every kind of item, dated or not. There is no separate reminders table any more (see
// migration 00056): a "reminder" is just an item with a `due`, and the scheduler fires anything dated
// regardless of which list it sits on. An Amazon item that must be ordered by Friday is a dated
// Amazon item — it fires and badges exactly like everything else. There are no classes of item.
//
// There is also ONE way for an item to leave a list: `deleted`. No separate "done" — checking
// something off and getting rid of it are the same act, and modelling them apart only produced two
// flags to keep in sync and two surfaces that disagreed about what a tick meant. `deleted` is soft:
// the row stays for a recovery window, then is purged.
export interface ListItem {
  id: string; list_name: string; text: string;
  title: string | null;      // short label for narrow surfaces; falls back to `text`
  due: string | null;        // local-naive 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' — dated ⇒ it fires
  repeat_every: string | null;   // '1 day', '2 hours', … — null ⇒ one-shot. Null IS the boolean.
  // When it was FIRST due. Never moves. `due` is the NEXT firing time and marches forward on a
  // repeater, so only this can answer "has its moment been and gone?" — see migration 00060.
  scheduled_at: string | null;
  deleted: boolean; created: string; updated: string;
}

/** Where an item goes when the caller didn't name a list. */
export const DEFAULT_LIST = 'todo';

/**
 * Repeating is OPT-IN. Dating something used to default it to a daily repeat, on the reasoning that a
 * one-shot notification missed while asleep is gone for good — but that safety net is better served
 * by the expired state: an item whose scheduled moment has passed stays visible and flagged until it
 * is cleared. That is a persistent signal; a daily re-fire is a transient one that can be missed just
 * as easily as the first, while adding noise to every appointment that has simply been and gone.
 *
 * Repeats remain a real feature for things that genuinely recur ("vitamins every evening").
 */

export async function availableLists(): Promise<string[]> {
  const { data } = await getClient().from('lists').select('name').order('name');
  return (data ?? []).map(r => r.name);
}

/** A list's emoji, or null. Lives on the list, not on its items — it describes the list. */
export async function listEmoji(listName: string): Promise<string | null> {
  const name = await resolveListName(listName);
  const { data } = await getClient().from('lists').select('emoji').eq('name', name).maybeSingle();
  return (data?.emoji as string | null) ?? null;
}

/** Set (or clear, with null) a list's emoji. Returns the stored list name, or null if none matched. */
export async function setListEmoji(listName: string, emoji: string | null): Promise<string | null> {
  const want = String(listName || '').trim();
  const names = await availableLists();
  const hit = names.find(n => n.toLowerCase() === want.toLowerCase());
  if (!hit) return null;
  await getClient().from('lists').update({ emoji: emoji || null }).eq('name', hit);
  return hit;
}

export async function listItems(listName: string): Promise<ListItem[]> {
  const { data } = await getClient().from('list_items').select('*')
    .eq('list_name', listName).eq('deleted', false).order('created');
  return (data ?? []) as ListItem[];
}

/**
 * Everything dated, across every list, ordered by when it was FIRST scheduled — so the longest
 * outstanding sits at the top and upcoming items follow. Ordering by `due` instead would shuffle a
 * repeating item to the back the moment it fired, which is precisely when it most needs attention.
 */
export async function dueItems(): Promise<ListItem[]> {
  const { data } = await getClient().from('list_items').select('*')
    .eq('deleted', false).not('due', 'is', null).order('scheduled_at');
  return (data ?? []) as ListItem[];
}

/** Its originally-scheduled moment has passed and it has not been cleared. Independent of repeating. */
export function isExpired(i: ListItem, nowLocal: string): boolean {
  if (!i.scheduled_at) return false;
  const m = /T\d/.test(i.scheduled_at) ? i.scheduled_at : `${i.scheduled_at.slice(0, 10)}T09:00:00`;
  return m <= nowLocal;
}

// Resolve a requested list name to an EXISTING one case-insensitively (so 'Grocery'/'GROCERY' hit the
// stored 'grocery'); falls back to the trimmed input for a genuinely new list. Without this, a caller's
// casing differing from what's stored (models default to Title Case) read back as a false "empty" and
// spawned case-variant duplicate lists.
export async function resolveListName(name: string): Promise<string> {
  const want = String(name || '').trim();
  const { data } = await getClient().from('lists').select('name');
  const hit = (data ?? []).find(r => String(r.name).toLowerCase() === want.toLowerCase());
  return hit ? String(hit.name) : want;
}

export async function addItem(
  listName: string,
  text: string,
  opts: { title?: string; due?: string; repeat_every?: string } = {},
): Promise<ListItem> {
  const sb = getClient();
  const list = await resolveListName(listName || DEFAULT_LIST);
  await sb.from('lists').upsert({ name: list }, { onConflict: 'name', ignoreDuplicates: true });
  const n = now(); const id = uuid();
  const { data } = await sb.from('list_items')
    .insert({
      id, list_name: list, text,
      title: opts.title?.trim() || null,
      due: opts.due || null,
      scheduled_at: opts.due || null,
      // Only meaningful alongside a due — a recurrence with no first occurrence has nothing to recur
      // from. Explicit '' (as opposed to absent) is how a caller asks for a genuine one-shot.
      // Only meaningful alongside a due — a recurrence with no first occurrence has nothing to
      // recur from.
      repeat_every: opts.due ? (opts.repeat_every?.trim() || null) : null,
      deleted: false, created: n, updated: n,
    })
    .select().single();
  return data as ListItem;
}

/** Clear an item — checking it off and removing it are the same thing. Soft, so it's recoverable. */
export async function removeItem(listName: string | null, idPrefix: string): Promise<ListItem | null> {
  const id = await resolveListItemId(listName, idPrefix);
  if (!id) return null;
  const n = now();
  await getClient().from('list_items').update({ deleted: true, updated: n }).eq('id', id);
  const { data } = await getClient().from('list_items').select('*').eq('id', id).single();
  return data as ListItem;
}

/**
 * Set, change or clear an item's due date and/or its repeat period. Passing due=null un-dates it,
 * which stops it firing; repeat_every=null makes a recurring item one-shot without un-dating it.
 * Fields are only touched when present, so re-dating something doesn't silently cancel its repeat.
 */
export async function setDue(
  listName: string | null,
  idPrefix: string,
  patch: { due?: string | null; repeat_every?: string | null },
): Promise<ListItem | null> {
  const id = await resolveListItemId(listName, idPrefix);
  if (!id) return null;
  const update: Record<string, unknown> = { updated: now() };
  if ('due' in patch) update.due = patch.due || null;
  // Anchor the first time something becomes dated, and only then — re-dating an already-dated item
  // must not move it, or the item would stop reading as expired just because it was rescheduled.
  if (patch.due) {
    const { data: cur } = await getClient().from('list_items').select('scheduled_at').eq('id', id).maybeSingle();
    if (!cur?.scheduled_at) update.scheduled_at = patch.due;
  }
  if (!update.due && 'due' in patch) update.scheduled_at = null;   // un-dated ⇒ no moment to have passed
  if ('repeat_every' in patch) update.repeat_every = patch.repeat_every || null;
  if (!update.due && 'due' in patch) update.repeat_every = null;   // un-dated ⇒ nothing left to repeat
  await getClient().from('list_items').update(update).eq('id', id);
  const { data } = await getClient().from('list_items').select('*').eq('id', id).single();
  return data as ListItem;
}

export async function createList(listName: string): Promise<boolean> {
  const { data } = await getClient().from('lists').select('name').eq('name', listName).maybeSingle();
  if (data) return false;
  await getClient().from('lists').insert({ name: listName });
  return true;
}

// Delete a whole list (case-insensitive) plus all its items. Returns the stored name, or null if none matched.
export async function removeList(listName: string): Promise<string | null> {
  const want = String(listName || '').trim();
  const names = await availableLists();
  const hit = names.find(n => n.toLowerCase() === want.toLowerCase());
  if (!hit) return null;
  await getClient().from('list_items').delete().eq('list_name', hit);
  await getClient().from('lists').delete().eq('name', hit);
  return hit;
}

// `listName` is optional: with reminders folded in, a caller often holds an id that came from the
// cross-list dated view and has no idea which list the item sits on. Omitting it searches all lists.
async function resolveListItemId(listName: string | null, prefix: string): Promise<string | null> {
  const sb = getClient();
  const list = listName ? await resolveListName(listName) : null;   // case-insensitive: 'Grocery' → 'grocery'

  let exactQ = sb.from('list_items').select('id').eq('id', prefix).eq('deleted', false);
  if (list) exactQ = exactQ.eq('list_name', list);
  const { data: exact } = await exactQ.maybeSingle();
  if (exact) return exact.id;

  let likeQ = sb.from('list_items').select('id').eq('deleted', false).like('id', `${prefix}%`);
  if (list) likeQ = likeQ.eq('list_name', list);
  const { data: matches } = await likeQ;
  if (matches?.length === 1) return matches[0].id;
  return null;
}

/** What a row calls itself on a narrow surface. */
export function itemLabel(i: ListItem): string {
  return (i.title && i.title.trim()) || i.text;
}

function line(i: ListItem, withList = false): string {
  const where = withList ? ` [${i.list_name}]` : '';
  const due = i.due ? ` (due: ${i.due}${i.repeat_every ? `, repeats every ${i.repeat_every}` : ''})` : '';
  return `- ${itemLabel(i)}${where}${due}  [id: ${i.id.slice(0, 8)}]`;
}

export function formatListItems(items: ListItem[], listName: string): string {
  if (!items.length) return `'${listName}' is empty.`;
  return `**${listName}** (${items.length} items):\n${items.map(i => line(i)).join('\n')}`;
}

/** The cross-list dated view. Says which list each item is on, since they come from all of them. */
export function formatDueItems(items: ListItem[]): string {
  if (!items.length) return 'Nothing has a due date.';
  return `**Due** (${items.length} items):\n${items.map(i => line(i, true)).join('\n')}`;
}
