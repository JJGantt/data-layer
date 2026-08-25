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
  deleted: boolean; created: string; updated: string;
}

/** Where an item goes when the caller didn't name a list. */
export const DEFAULT_LIST = 'todo';

export async function availableLists(): Promise<string[]> {
  const { data } = await getClient().from('lists').select('name').order('name');
  return (data ?? []).map(r => r.name);
}

export async function listItems(listName: string): Promise<ListItem[]> {
  const { data } = await getClient().from('list_items').select('*')
    .eq('list_name', listName).eq('deleted', false).order('created');
  return (data ?? []) as ListItem[];
}

/** Everything dated, across every list, soonest first — the view that used to be "reminders". */
export async function dueItems(): Promise<ListItem[]> {
  const { data } = await getClient().from('list_items').select('*')
    .eq('deleted', false).not('due', 'is', null).order('due');
  return (data ?? []) as ListItem[];
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
      repeat_every: opts.repeat_every?.trim() || null,
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
  if ('repeat_every' in patch) update.repeat_every = patch.repeat_every || null;
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
