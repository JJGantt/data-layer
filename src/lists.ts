import { getClient } from './client.js';
import { now, toEastern, uuid, ValidationError } from './helpers.js';

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
  id: string;
  // WHICH LIST, and the identity of it. `list_name` beside this is a DERIVED copy maintained by the
  // list_items_resolve_list trigger (00094) for the hub's sake — read it, never write it, and never
  // treat it as the key: it changes when a list is renamed and `list_id` does not.
  list_id: string;
  list_name: string;
  text: string;
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
  // Should it RING rather than notify? An alarm-grade item plays on a loop on the TV and on any open
  // hub page from its moment until someone stops it (status-hub docs/ALARMS.md).
  //
  // Like `priority`, ONLY EVER SET FROM WHAT HE ACTUALLY SAID, and for a sharper reason: this one
  // wakes a room. A soup timer should and an errand at 2am should not, and no property of an item
  // tells you which it is — "alarm", "wake me", "timer" do.
  alarm: boolean;
  series_id: string | null;  // set on every occurrence one scheduling request produced
  // When it was DONE. Null means outstanding. A timestamp rather than a flag because the score needs
  // to know how late it was, and a boolean beside the time is a field that can contradict it.
  completed_at: string | null;
  deleted: boolean; created: string; updated: string;
}

/** Outstanding: not done, not deleted. What every active surface means by "on the list". */
export const ACTIVE = 'deleted=false,completed_at=null';

/** Where an item goes when the caller didn't name a list. An ID, like every other list reference. */
export const DEFAULT_LIST_ID = 'l_todo';

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

/** A list. `id` is the identity and never changes; `name` is a label and can be edited freely. */
export interface List {
  id: string; name: string; emoji: string | null; default_priority: number; created: string;
}

export async function allLists(): Promise<List[]> {
  const { data } = await getClient().from('lists').select('*').order('name');
  return (data ?? []) as List[];
}

export async function getList(listId: string): Promise<List | null> {
  const { data } = await getClient().from('lists').select('*').eq('id', String(listId || '').trim()).maybeSingle();
  return (data as List | null) ?? null;
}

/**
 * The list, or a thrown error naming every id that would have worked.
 *
 * This is the whole point of the id: an unknown one is REJECTED here rather than created. When the
 * name was the key there was nothing to reject against — "a name not in the table" was how a new
 * list got made, so a typo and an intention were the same request (00094).
 */
export async function requireList(listId: string): Promise<List> {
  const want = String(listId || '').trim();
  const list = want ? await getList(want) : null;
  if (list) return list;
  const known = (await allLists()).map(l => `${l.id} (${l.name})`).join(', ');
  throw new ValidationError(
    `no list with id '${want}'. Existing lists: ${known || 'none'}. `
    + `To start a new list use create_list; add_to_list only adds to one that exists.`);
}

/** Create a list and mint its id. The ONLY way a list comes into existence. */
export async function createList(
  name: string,
  opts: { emoji?: string | null; default_priority?: number } = {},
): Promise<List> {
  const clean = String(name || '').trim();
  if (!clean) throw new ValidationError('a list needs a name');
  const existing = (await allLists()).find(l => l.name.toLowerCase() === clean.toLowerCase());
  if (existing) throw new ValidationError(`'${existing.name}' already exists (id ${existing.id})`);

  // Readable, because these ids go in an `enum` a model picks from and an opaque key would make that
  // choice unverifiable. Derived from the name ONCE and never recomputed — a rename leaves it alone,
  // which is what makes it an id rather than a second copy of the name.
  const base = 'l_' + (clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'list');
  const taken = new Set((await allLists()).map(l => l.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;

  const row = {
    id, name: clean, emoji: opts.emoji || null,
    default_priority: clampPriority(opts.default_priority ?? 0), created: now(),
  };
  const { data, error } = await getClient().from('lists').insert(row).select().single();
  if (error) throw new ValidationError(error.message);
  return data as List;
}

/** What new items on this list start as. Lists that predate the column read 0. */
export async function listDefaultPriority(listId: string): Promise<number> {
  const { data } = await getClient().from('lists').select('default_priority').eq('id', listId).maybeSingle();
  return clampPriority(data?.default_priority);
}

/**
 * Set what new items on a list inherit — 'everything on work is exempt'.
 *
 * It does NOT touch items already there. Their priority was copied onto them when they were made and
 * they have scores attached to it; changing a default should not quietly rewrite what the past was
 * worth. Returns the stored list name, or null if none matched.
 */
export async function setListDefaultPriority(listId: string, priority: number): Promise<List> {
  const list = await requireList(listId);
  const { data } = await getClient().from('lists')
    .update({ default_priority: clampPriority(priority) }).eq('id', list.id).select().single();
  return data as List;
}

/** A list's emoji, or null. Lives on the list, not on its items — it describes the list. */
export async function listEmoji(listId: string): Promise<string | null> {
  const { data } = await getClient().from('lists').select('emoji').eq('id', listId).maybeSingle();
  return (data?.emoji as string | null) ?? null;
}

/** Set (or clear, with null) a list's emoji. */
export async function setListEmoji(listId: string, emoji: string | null): Promise<List> {
  const list = await requireList(listId);
  const { data } = await getClient().from('lists')
    .update({ emoji: emoji || null }).eq('id', list.id).select().single();
  return data as List;
}

export async function listItems(listId: string): Promise<ListItem[]> {
  const { data } = await getClient().from('list_items').select('*')
    .eq('list_id', listId).eq('deleted', false).is('completed_at', null).order('created');
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

/**
 * Overdue: it is no longer on time and it has not been cleared. A timed item is late at its own moment.
 * A date-only item is on time for its whole day and late at the next day's 4am origin — the hub's
 * scoring deadline (`taskDeadline` in status-hub `lib/score.js`), which is what makes an item cost
 * points, so it is also what makes one overdue. It still FIRES at 9am; when it notifies and when it is
 * late are different questions.
 */
export function isExpired(i: ListItem, nowLocal: string): boolean {
  const at = i.scheduled_at ?? i.due;
  if (!at) return false;
  if (/T\d/.test(at)) return at <= nowLocal;
  const [y, mo, d] = at.slice(0, 10).split('-').map(Number);
  const late = new Date(Date.UTC(y, mo - 1, d + 1, 4)).toISOString().slice(0, 19);
  return late <= nowLocal;
}

export interface AddOpts {
  title?: string;
  due?: string;
  /** Omit to inherit the list's default. A number here is an explicit override, 0 included. */
  priority?: number;
  /** True makes it RING on the TV and any open hub page rather than notify. Requires `due` to mean anything. */
  alarm?: boolean;
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
export async function addItem(listId: string, text: string, opts: AddOpts = {}): Promise<ListItem[]> {
  const sb = getClient();
  // Throws when the id is unknown. It does NOT create the list: creating one is `createList`, and
  // keeping the two apart is what makes a wrong id a rejectable value rather than a new list (00094).
  const list = await requireList(listId || DEFAULT_LIST_ID);
  const n = now();
  // Omitted means INHERIT the list's default; a number means he said so, and 0 is a real answer.
  // The distinction has to survive all the way from the tool call, which is why this reads `== null`
  // rather than falsy — `priority: 0` from a caller must override an exempt list, not be ignored.
  const priority = opts.priority == null ? clampPriority(list.default_priority) : clampPriority(opts.priority);
  const title = opts.title?.trim() || null;

  // A recurrence with no first occurrence has nothing to recur from, so it is only read alongside a
  // due — anything else is a one-off however it was asked for.
  const every = opts.due ? (opts.repeat_every?.trim() || '') : '';
  const occurrences = every
    ? seriesOccurrences(opts.due as string, every, opts.repeat_until)
    : [opts.due || null];
  const seriesId = every ? uuid() : null;

  // `list_name` is left to the trigger: it is derived from `list_id`, and sending both is how the two
  // get a chance to disagree.
  // An alarm with no moment to ring at is not an alarm, so the flag only survives alongside a due —
  // the same rule `repeat_every` follows two lines up, and for the same reason.
  const alarm = !!opts.alarm && !!opts.due;
  const rows = occurrences.map(due => ({
    id: uuid(), list_id: list.id, text, title,
    due, scheduled_at: due, priority, alarm, series_id: seriesId,
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
    } else if (unit === 'day' || unit === 'week') {
      // Calendar days, not 24-hour steps: across a DST change a 24h step lands an hour off the
      // wall-clock time asked for (8:00 becomes 7:00 in November), and a date-only item lands on the
      // same date twice.
      dt = new Date(y, mo - 1, d + (unit === 'week' ? 7 : 1) * step * k, hh, mi, 0);
    } else {
      const ms = unit === 'hour' ? 3600000 : 60000;
      dt = new Date(new Date(y, mo - 1, d, hh, mi, 0).getTime() + step * k * ms);
    }
    const s = fmt(dt);
    if (s.slice(0, 10) > lastDay) break;
    out.push(s);
  }
  return out.length ? out : [firstDue];
}

// How far ahead of this host's clock a completion stamp is still accepted. The hub and this layer
// write `completed_at` from different machines with different clocks; without a tolerance an
// ordinary "done, now" from a host running a minute fast would be refused as time travel. Far below
// the 30-minute scoring grace, so it can never change what a completion is worth.
const STAMP_SKEW_MS = 2 * 60000;

/**
 * Check a caller-supplied completion time before it reaches the column.
 *
 * The hub's `lib/score.js` holds the same rule (`completionStamp`) because the hub's own endpoint
 * writes this column too, while this layer writes to Supabase directly rather than through it. Two
 * doors into one column, so each one checks. Keep them saying the same thing.
 *
 * TIMEZONE: `completed_at` is scored against `due` as naive wall-clock arithmetic, so a stamp
 * carrying a Z or a +HH:MM is refused rather than converted — converting means guessing an offset,
 * and a guessed offset is how a completion lands an hour from the deadline it is measured against.
 * Deliberately not the UTC conversion in helpers, which reads a bare stamp as UTC: right where a model is naming a
 * date, catastrophic here, where the same reading would shift every retroactive completion by the
 * whole offset and quietly turn an on-time one into four hours late.
 *
 * FUTURE: refused. The band replays completions up to now and skips anything past it, so a future
 * stamp would take the item off every active list and score nothing — which reads as a broken score
 * rather than a bad input. The distant past is fine: it earns nothing once it is older than the
 * decay window, but that is the decay working on a true record of something that happened.
 */
export function checkCompletedAt(
  at: string,
  reference: string = now(),
): { ok: true; value: string } | { ok: false; reason: string } {
  const raw = String(at ?? '').trim();
  if (!raw) return { ok: false, reason: 'a completion time is required' };
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw);
  if (!m) return { ok: false, reason: 'expected local wall clock YYYY-MM-DDTHH:MM (or YYYY-MM-DD), with no timezone' };
  const value = m[2] == null ? m[1] : `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}`;
  const ms = (s: string) => Date.parse(`${s.length === 10 ? `${s}T00:00:00` : s.slice(0, 19)}Z`);
  const t = ms(value);
  // Date.parse ROLLS OVER out-of-range components, so month 13 and day 45 each yield a real instant
  // in the wrong place rather than an error. Only the round trip catches that.
  if (isNaN(t) || new Date(t).toISOString().slice(0, 19) !== (m[2] == null ? `${value}T00:00:00` : value)) {
    return { ok: false, reason: 'not a real date' };
  }
  const ref = ms(reference);
  if (!isNaN(ref) && t > ref + STAMP_SKEW_MS) return { ok: false, reason: 'is in the future' };
  return { ok: true, value };
}

/**
 * Mark an item DONE. It leaves the active lists, stays on the calendar, and — if it was dated —
 * scores the health bar's gold band according to how late it was.
 *
 * `at` exists because the completion time is the whole input to the score and the caller sometimes
 * knows it better than the clock does. Two different cases: under the voice worker `now()` is
 * already the moment he started speaking, which is the right reference for "I just did it"; `at` is
 * for a completion that is not now at all — "I finished that at 10:15", or finishing a 10am thing a
 * quarter of an hour into it. It takes a local wall-clock reading in the same shape `due` is stored
 * in, and THROWS on one this layer cannot honour rather than storing a stamp the band would then
 * ignore. Checked before the item is even resolved, so a bad time changes nothing.
 */
export async function completeItem(
  listId: string | null,
  idPrefix: string,
  opts: { undo?: boolean; at?: string } = {},
): Promise<ListItem | null> {
  const n = now();
  let stamp = n;
  if (!opts.undo && opts.at != null && String(opts.at).trim() !== '') {
    const c = checkCompletedAt(String(opts.at), n);
    if (!c.ok) throw new ValidationError(`completion time ${c.reason}`);
    stamp = c.value;
  }
  const id = await resolveListItemId(listId, idPrefix, { includeCompleted: !!opts.undo });
  if (!id) return null;
  await getClient().from('list_items')
    .update({ completed_at: opts.undo ? null : stamp, updated: n }).eq('id', id);
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
export async function removeItem(listId: string | null, idPrefix: string): Promise<ListItem | null> {
  const id = await resolveListItemId(listId, idPrefix);
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
  listId: string | null,
  idPrefix: string,
  patch: { due?: string | null },
): Promise<ListItem | null> {
  const id = await resolveListItemId(listId, idPrefix);
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
  listId: string | null,
  idPrefix: string,
  priority: number,
): Promise<ListItem | null> {
  const id = await resolveListItemId(listId, idPrefix);
  if (!id) return null;
  const p = clampPriority(priority);
  await getClient().from('list_items').update({ priority: p, updated: now() }).eq('id', id);
  const { data } = await getClient().from('list_items').select('*').eq('id', id).single();
  return data as ListItem;
}

/**
 * Turn an existing item into an alarm, or back into an ordinary dated item.
 *
 * Separate from setPriority even though the shape is identical: these are different questions and a
 * combined verb would invite answering one while meaning the other. Important is about SCORE; alarm
 * is about whether it wakes you.
 */
export async function setAlarm(
  listId: string | null,
  idPrefix: string,
  alarm: boolean,
): Promise<ListItem | null> {
  const id = await resolveListItemId(listId, idPrefix);
  if (!id) return null;
  await getClient().from('list_items').update({ alarm, updated: now() }).eq('id', id);
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

/** Delete a whole list plus all its items. Returns the list as it was. */
export async function removeList(listId: string): Promise<List> {
  const list = await requireList(listId);
  await getClient().from('list_items').delete().eq('list_id', list.id);
  await getClient().from('lists').delete().eq('id', list.id);
  return list;
}

// `listName` is optional: with reminders folded in, a caller often holds an id that came from the
// cross-list dated view and has no idea which list the item sits on. Omitting it searches all lists.
async function resolveListItemId(
  listId: string | null,
  prefix: string,
  opts: { includeCompleted?: boolean } = {},
): Promise<string | null> {
  const sb = getClient();
  const list = listId ? String(listId).trim() || null : null;
  // Completed items are invisible to every caller but undo, which by definition names one.
  const scope = (q: any) => (opts.includeCompleted ? q : q.is('completed_at', null));

  let exactQ = scope(sb.from('list_items').select('id').eq('id', prefix).eq('deleted', false));
  if (list) exactQ = exactQ.eq('list_id', list);
  const { data: exact } = await exactQ.maybeSingle();
  if (exact) return exact.id;

  let likeQ = scope(sb.from('list_items').select('id').eq('deleted', false).like('id', `${prefix}%`));
  if (list) likeQ = likeQ.eq('list_id', list);
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
  // Parsed as UTC, so the subtraction is exact wall-clock arithmetic with no DST step in it — the
  // same reading the hub's band takes (lib/score.js `naive`). Read as LOCAL instead and a completion
  // spanning a clock change comes out an hour off, which matters most on exactly the completions
  // this function now describes: the ones reported after the fact, for a time that already passed.
  const at = (s: string) => Date.parse(`${s.length === 10 ? `${s}T00:00:00` : s.slice(0, 19)}Z`);
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
  // Stated, because it is the one property that changes what an item DOES rather than what it is
  // worth — a reader who cannot see it cannot tell which of his dated items will wake him.
  const rings = i.alarm ? ' [alarm]' : '';
  const done = i.completed_at ? ` [done ${i.completed_at.slice(0, 16).replace('T', ' ')}]` : '';
  const series = i.series_id ? ` [series: ${i.series_id.slice(0, 8)}]` : '';
  const head = `- ${itemLabel(i)}${where}${due}${flag}${rings}${done}${series}  [id: ${i.id.slice(0, 8)}]`;
  // An item whose `text` is longer than its label is carrying a BODY, and the label alone does not
  // contain it — a note (migration 00092) is exactly that, and reading one back has to return what
  // was written. Indented so the item stays one visual row when the body is empty, which is most of
  // them. `itemLabel` falls back to `text`, so this is silent for every item without a title.
  const body = String(i.text ?? '').trim();
  return body && body !== itemLabel(i) ? `${head}\n${body.split('\n').map(l => '    ' + l).join('\n')}` : head;
}

export function formatListItems(items: ListItem[], list: List): string {
  // The default is stated on the header because it silently shapes everything added here — without
  // it, a caller cannot tell why a new item on `work` came out exempt. The id is stated because it is
  // what every write takes, and a reader who only ever sees the name will pass the name.
  const p = clampPriority(list.default_priority);
  const def = p > 0 ? ', new items default to important' : p < 0 ? ', new items default to exempt' : '';
  const head = `${list.name} [${list.id}]`;
  if (!items.length) return `${head} is empty${def}.`;
  return `**${head}** (${items.length} items${def}):\n${items.map(i => line(i)).join('\n')}`;
}

/** The cross-list dated view. Says which list each item is on, since they come from all of them. */
export function formatDueItems(items: ListItem[]): string {
  if (!items.length) return 'Nothing has a due date.';
  return `**Due** (${items.length} items):\n${items.map(i => line(i, true)).join('\n')}`;
}
