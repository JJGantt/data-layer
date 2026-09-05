import { getClient } from './client.js';
import { now, toEastern, uuid } from './helpers.js';

// Lists hold every kind of item, dated or not. There is no separate reminders table any more (see
// migration 00056): a "reminder" is just an item with a `due`, and the scheduler fires anything dated
// regardless of which list it sits on. An Amazon item that must be ordered by Friday is a dated
// Amazon item — it fires and badges exactly like everything else. There are no classes of item.
//
// There is also ONE way for an item to leave a list: `deleted`. No separate "done" — checking
// something off and getting rid of it are the same act, and modelling them apart only produced two
// flags to keep in sync and two surfaces that disagreed about what a tick meant. `deleted` is soft:
// the row stays for a recovery window, then is purged.
//
// There is, separately, one way for an item to be DONE: `completed_at` (migration 00088). The two
// are not variants of each other and the difference is visible, not bookkeeping:
//
//   completeItem   it happened. Leaves the active lists, stays on the calendar, scores the gold band.
//   removeItem     it is gone. No credit, no record, purged after the recovery window.
//
// This was tried the other way round first — one verb, with the clock deciding what a removal meant.
// It failed on contact: with no completion verb to land on, "take the shirt off the list and put it
// back up at 1 for the dryer" routed to `setDue` and moved the item, collapsing two instructions
// into one reschedule. Distinct outcomes need distinct verbs, and these two are distinct in speech
// as well — "done", "finished", "checked off" against "delete", "get rid of", "I'm not doing it".
export interface ListItem {
  id: string; list_name: string; text: string;
  title: string | null;      // short label for narrow surfaces; falls back to `text`
  due: string | null;        // local-naive 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MM' — dated ⇒ it fires
  // When it was scheduled for. Equal to `due` now that nothing moves a due date (00085 materialised
  // recurrence, so there is no next-occurrence to march to); kept because every surface reads it and
  // because it is the occurrence key the score ledger joins on.
  scheduled_at: string | null;
  // 1 important (counts double), 0 normal, -1 EXEMPT — scheduled and notified like anything else,
  // but scored in neither direction and checked off automatically once its moment passes.
  //
  // ONLY EVER SET FROM WHAT HE ACTUALLY SAID. The tool descriptions deliberately refuse to infer it
  // from what an item is, even though a work shift is obviously not a chore: a guess here silently
  // changes what his score does, and nothing on any surface says a guess was made. He asked for the
  // words to be the trigger — "important", "exempt" — and for everything else to stay 0.
  priority: number;
  series_id: string | null;  // set on every occurrence one scheduling request produced
  // When it was DONE. Null means outstanding. A timestamp rather than a flag because the score needs
  // to know how late it was, and a boolean beside the time is a field that can contradict it.
  completed_at: string | null;
  deleted: boolean; created: string; updated: string;
}

/** Outstanding: not done, not deleted. What every active surface means by "on the list". */
export const ACTIVE = 'deleted=false,completed_at=null';

/** Where an item goes when the caller didn't name a list. */
export const DEFAULT_LIST = 'todo';

/** Nothing is owed on an exempt item, so it scores nothing and closes itself when its moment goes. */
export const PRIORITY_EXEMPT = -1;
export const isExempt = (i: Pick<ListItem, 'priority'>) => (Number(i.priority) || 0) < 0;
const clampPriority = (p: unknown) => Math.max(-1, Math.min(1, Math.round(Number(p) || 0)));

/**
 * Recurrence is MATERIALISED, not stored. "Every day for the next month" is executed once, here, and
 * produces thirty independent dated items sharing a `series_id`; there is no repeating row and no
 * `repeat_every` column any more (migration 00085).
 *
 * The old shape could not be scored. A repeating row's `due` marched into the future the instant it
 * fired, so nothing could say which occurrence had just been checked off, and its anchor sat
 * permanently in the past, so a drain derived from it would bleed forever from an item that was
 * working correctly. Materialised occurrences have neither problem, because there is no longer a
 * category of item that behaves differently: everything is a one-shot.
 *
 * The consequences are deliberate. Checking off today's does not touch tomorrow's, and a skipped
 * week is seven separate misses rather than one — which is what it actually was. The horizon is
 * finite and comes from the request, because "every day" has no stopping point and a background job
 * quietly topping the list up forever is the kind of thing that breaks silently; running out is a
 * prompt to re-up, not a failure.
 */
export const SERIES_DEFAULT_HORIZON_DAYS = 30;
/** How far ahead the dated view reaches when a caller doesn't say. Overdue is never bounded away. */
export const DUE_DEFAULT_DAYS = 2;
const SERIES_MAX_OCCURRENCES = 366;      // a hard stop, so a bad interval cannot flood a list

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
    .eq('list_name', listName).eq('deleted', false).is('completed_at', null).order('created');
  return (data ?? []) as ListItem[];
}

/** What has been DONE, newest first. The calendar draws these; nothing else does. */
export async function completedItems(sinceDate?: string): Promise<ListItem[]> {
  let q = getClient().from('list_items').select('*')
    .eq('deleted', false).not('completed_at', 'is', null);
  if (sinceDate) q = q.gte('completed_at', sinceDate);
  const { data } = await q.order('completed_at', { ascending: false });
  return (data ?? []) as ListItem[];
}

/**
 * Everything dated, across every list, ordered by when it was scheduled — longest outstanding first,
 * upcoming after.
 *
 * `withinDays` bounds the far end and matters more than it looks: materialised series mean a list
 * can hold a month of identical-looking occurrences, and handing a model thirty rows that differ
 * only by date is how "check off the teeth brushing" stops having one obvious answer. Scoped to the
 * near horizon there is exactly one, and it can be named by id with no matching involved. Overdue
 * items are never bounded away — they are the ones that need attention.
 */
export async function dueItems(withinDays?: number): Promise<ListItem[]> {
  const { data } = await getClient().from('list_items').select('*')
    .eq('deleted', false).is('completed_at', null).not('due', 'is', null).order('scheduled_at');
  const all = (data ?? []) as ListItem[];
  if (withinDays == null) return all;
  const cutoff = new Date(now().slice(0, 10) + 'T00:00:00');
  cutoff.setDate(cutoff.getDate() + withinDays + 1);
  const limit = toEastern(cutoff).slice(0, 10);
  return all.filter(i => (i.scheduled_at ?? i.due ?? '').slice(0, 10) < limit);
}

/** Its scheduled moment has passed and it has not been cleared. A date-only item fires at 9am. */
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

export interface AddOpts {
  title?: string;
  due?: string;
  priority?: number;
  /** '<n> <unit>' — makes this a series. Requires `due`, which is the first occurrence. */
  repeat_every?: string;
  /** Last date a series occurrence may fall on. Defaults to SERIES_DEFAULT_HORIZON_DAYS out. */
  repeat_until?: string;
}

/**
 * Add one item, or — with `repeat_every` — the whole series in one call. Returns every row created,
 * first occurrence first, so a caller can report what it actually committed to rather than the
 * instruction it was given.
 */
export async function addItem(listName: string, text: string, opts: AddOpts = {}): Promise<ListItem[]> {
  const sb = getClient();
  const list = await resolveListName(listName || DEFAULT_LIST);
  await sb.from('lists').upsert({ name: list }, { onConflict: 'name', ignoreDuplicates: true });
  const n = now();
  const priority = clampPriority(opts.priority);
  const title = opts.title?.trim() || null;

  // A recurrence with no first occurrence has nothing to recur from, so it is only read alongside a
  // due — anything else is a one-off however it was asked for.
  const every = opts.due ? (opts.repeat_every?.trim() || '') : '';
  const occurrences = every
    ? seriesOccurrences(opts.due as string, every, opts.repeat_until)
    : [opts.due || null];
  const seriesId = every ? uuid() : null;

  const rows = occurrences.map(due => ({
    id: uuid(), list_name: list, text, title,
    due, scheduled_at: due, priority, series_id: seriesId,
    deleted: false, created: n, updated: n,
  }));
  const { data } = await sb.from('list_items').insert(rows).select();
  const made = (data ?? []) as ListItem[];
  return made.sort((a, b) => String(a.due ?? '').localeCompare(String(b.due ?? '')));
}

/**
 * The occurrences one scheduling request expands to, first included.
 *
 * Each is computed from the ANCHOR rather than from the previous result. Month arithmetic clamps
 * (Jan 31 + 1 month = Feb 28) and stepping from the last result makes the clamp stick, so a monthly
 * item anchored on the 31st would degrade to the 28th permanently — the wart migration 00060 was
 * written to retire. Stepping k intervals from the anchor keeps the intended day of month forever.
 */
export function seriesOccurrences(firstDue: string, every: string, until?: string): string[] {
  const spec = /^(\d+)\s*(minute|hour|day|week|month|year)s?$/.exec(String(every).trim().toLowerCase());
  if (!spec) return [firstDue];
  const step = Number(spec[1]); const unit = spec[2];
  if (!(step > 0)) return [firstDue];

  const timed = /T\d/.test(firstDue);
  const [datePart, timePart = '00:00'] = firstDue.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const [hh, mi] = timePart.split(':').map(Number);

  const horizon = new Date(`${datePart}T00:00:00`);
  if (until) { const u = new Date(`${until.slice(0, 10)}T00:00:00`); if (!isNaN(u.getTime())) horizon.setTime(u.getTime()); }
  else horizon.setDate(horizon.getDate() + SERIES_DEFAULT_HORIZON_DAYS);
  const lastDay = toEastern(horizon).slice(0, 10);

  const fmt = (dt: Date) => (timed ? toEastern(dt).slice(0, 16) : toEastern(dt).slice(0, 10));
  const out: string[] = [];
  for (let k = 0; out.length < SERIES_MAX_OCCURRENCES; k++) {
    let dt: Date;
    if (unit === 'month' || unit === 'year') {
      const months = (unit === 'year' ? 12 : 1) * step * k;
      const target = new Date(y, (mo - 1) + months, 1, hh, mi, 0);
      // Clamp to the month's length rather than rolling into the next one.
      const daysIn = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
      dt = new Date(target.getFullYear(), target.getMonth(), Math.min(d, daysIn), hh, mi, 0);
    } else {
      const ms = { minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }[unit] as number;
      dt = new Date(new Date(y, mo - 1, d, hh, mi, 0).getTime() + step * k * ms);
    }
    const s = fmt(dt);
    if (s.slice(0, 10) > lastDay) break;
    out.push(s);
  }
  return out.length ? out : [firstDue];
}

/**
 * Mark an item DONE. It leaves the active lists, stays on the calendar, and — if it was dated —
 * scores the health bar's gold band according to how late it was.
 *
 * `at` exists because the completion time is the whole input to the score and the caller sometimes
 * knows it better than the clock does: under the voice worker `now()` is the moment he started
 * speaking, which is the right reference for "I just did it".
 */
export async function completeItem(
  listName: string | null,
  idPrefix: string,
  opts: { undo?: boolean; at?: string } = {},
): Promise<ListItem | null> {
  const id = await resolveListItemId(listName, idPrefix, { includeCompleted: !!opts.undo });
  if (!id) return null;
  const n = now();
  await getClient().from('list_items')
    .update({ completed_at: opts.undo ? null : (opts.at || n), updated: n }).eq('id', id);
  const { data } = await getClient().from('list_items').select('*').eq('id', id).single();
  return data as ListItem;
}

/**
 * Delete an item. It is GONE — no credit, no record, and it does not appear on the calendar as
 * something that happened. Soft, so a mistake is recoverable until the hub purges it.
 *
 * This is not how something gets checked off; that is `completeItem`. The two were briefly one call
 * with the clock deciding between them, which is exactly how a completion became a reschedule.
 */
export async function removeItem(listName: string | null, idPrefix: string): Promise<ListItem | null> {
  const id = await resolveListItemId(listName, idPrefix);
  if (!id) return null;
  const n = now();
  await getClient().from('list_items').update({ deleted: true, updated: n }).eq('id', id);
  const { data } = await getClient().from('list_items').select('*').eq('id', id).single();
  return data as ListItem;
}

/**
 * Set, change or clear an item's due date. Passing due=null un-dates it, which stops it firing and
 * takes it out of scoring entirely — an item with no deadline cannot be early or late.
 *
 * Rescheduling MOVES the anchor, which is new since 00085. It used to be pinned at first dating so a
 * repeating item's marching `due` could not erase the fact that its moment had passed; nothing
 * marches any more, and a deliberately postponed item should genuinely not read as overdue until its
 * new moment. Snoozing is the same operation and gets the same treatment.
 */
export async function setDue(
  listName: string | null,
  idPrefix: string,
  patch: { due?: string | null },
): Promise<ListItem | null> {
  const id = await resolveListItemId(listName, idPrefix);
  if (!id) return null;
  const update: Record<string, unknown> = { updated: now() };
  if ('due' in patch) { update.due = patch.due || null; update.scheduled_at = patch.due || null; }
  await getClient().from('list_items').update(update).eq('id', id);
  const { data } = await getClient().from('list_items').select('*').eq('id', id).single();
  return data as ListItem;
}

/**
 * How much an item counts, in both directions: an important one earns more for being done on time
 * and drains more for being ignored. It changes nothing else — not when it fires, not how it
 * notifies.
 */
export async function setPriority(
  listName: string | null,
  idPrefix: string,
  priority: number,
): Promise<ListItem | null> {
  const id = await resolveListItemId(listName, idPrefix);
  if (!id) return null;
  const p = clampPriority(priority);
  await getClient().from('list_items').update({ priority: p, updated: now() }).eq('id', id);
  const { data } = await getClient().from('list_items').select('*').eq('id', id).single();
  return data as ListItem;
}

/**
 * Clear every remaining occurrence of a series in one go.
 *
 * This is the operation materialised recurrence owes you: without it, stopping a daily item means
 * removing thirty rows by hand. Deleting scores nothing at all, so calling off a series is free —
 * and the occurrences already completed are untouched, since they are not outstanding.
 */
export async function removeSeries(seriesId: string): Promise<ListItem[]> {
  const sb = getClient();
  const { data: open } = await sb.from('list_items').select('*')
    .eq('series_id', seriesId).eq('deleted', false).is('completed_at', null).order('scheduled_at');
  const rows = (open ?? []) as ListItem[];
  if (!rows.length) return [];
  // One at a time: the trigger is per-row, and a bulk update would still fire it per row but gives
  // no way to report which occurrences were affected.
  const n = now();
  for (const r of rows) await sb.from('list_items').update({ deleted: true, updated: n }).eq('id', r.id);
  return rows;
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
async function resolveListItemId(
  listName: string | null,
  prefix: string,
  opts: { includeCompleted?: boolean } = {},
): Promise<string | null> {
  const sb = getClient();
  const list = listName ? await resolveListName(listName) : null;   // case-insensitive: 'Grocery' → 'grocery'
  // Completed items are invisible to every caller but undo, which by definition names one.
  const scope = (q: any) => (opts.includeCompleted ? q : q.is('completed_at', null));

  let exactQ = scope(sb.from('list_items').select('id').eq('id', prefix).eq('deleted', false));
  if (list) exactQ = exactQ.eq('list_name', list);
  const { data: exact } = await exactQ.maybeSingle();
  if (exact) return exact.id;

  let likeQ = scope(sb.from('list_items').select('id').eq('deleted', false).like('id', `${prefix}%`));
  if (list) likeQ = likeQ.eq('list_name', list);
  const { data: matches } = await likeQ;
  if (matches?.length === 1) return matches[0].id;
  return null;
}

/**
 * How a completion landed relative to its deadline, in his terms — so the spoken reply can say it.
 * Untimed items are due by the end of their day, timed ones at their moment.
 */
export function lateness(i: ListItem): string | null {
  if (!i.completed_at || !i.due) return null;
  const timed = /T\d/.test(i.due);
  const at = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00` : s).getTime();
  const deadline = timed ? at(i.due) : at(i.due.slice(0, 10)) + 28 * 3600000;   // next day's 4am
  const mins = Math.round((at(i.completed_at) - deadline) / 60000);
  if (mins <= 30) return 'on time';
  if (mins < 120) return `${mins} min late`;
  const hrs = mins / 60;
  return hrs < 48 ? `${Math.round(hrs)}h late` : `${Math.round(hrs / 24)}d late`;
}

/** What a row calls itself on a narrow surface. */
export function itemLabel(i: ListItem): string {
  return (i.title && i.title.trim()) || i.text;
}

function line(i: ListItem, withList = false): string {
  const where = withList ? ` [${i.list_name}]` : '';
  const due = i.due ? ` (due: ${i.due})` : '';
  const flag = i.priority > 0 ? ' [important]' : i.priority < 0 ? ' [exempt]' : '';
  const done = i.completed_at ? ` [done ${i.completed_at.slice(0, 16).replace('T', ' ')}]` : '';
  const series = i.series_id ? ` [series: ${i.series_id.slice(0, 8)}]` : '';
  return `- ${itemLabel(i)}${where}${due}${flag}${done}${series}  [id: ${i.id.slice(0, 8)}]`;
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
