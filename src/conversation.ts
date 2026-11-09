import { getClient } from './client.js';

// Past days of the hub conversation, read on demand. The voice worker replays only TODAY into each turn
// (voice-pipeline `recent_context`), so anything said on an earlier day reaches the model through this
// tool or not at all. The rows are `voice_messages` with focus/mode `hub`: each turn's user words and
// its final reply, plus session replies relayed into the thread. Tool results were never stored, so a
// past turn's data has to be fetched again if it is needed now.

const TZ = process.env.TZ_DISPLAY || 'America/New_York';
const DAY_STARTS_HOUR = 4;     // the hub's day, the same boundary recent_context and lib/dates.js use
const MAX_CHARS = 60000;       // a whole busy day is ~30k; past this the answer stops and says so

/** Minutes TZ is ahead of UTC at instant `ms`. */
function offsetMin(ms: number): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return Math.round((asUtc - ms) / 60000);
}

/** The UTC instant of `day` (YYYY-MM-DD) at 4:00 AM in TZ — where that day of the conversation starts. */
export function dayStartUtc(day: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, DAY_STARTS_HOUR);
  // Two passes: the offset at the guess, then at the corrected instant, which settles across a DST change.
  let t = guess - offsetMin(guess) * 60000;
  t = guess - offsetMin(t) * 60000;
  return new Date(t);
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** The conversation day (4am-origin, TZ) an instant belongs to. */
export function dayOf(iso: string): string {
  const ms = new Date(iso).getTime() - DAY_STARTS_HOUR * 3600000;
  return new Date(ms + offsetMin(ms) * 60000).toISOString().slice(0, 10);
}

export interface Row {
  role: string; text: string | null; created_at: string;
  ignored?: boolean | null; session_id?: string | null; session_label?: string | null;
}

/** One line per message, in the shape the worker's "Today so far" block uses, under a heading per day. */
export function formatRows(rows: Row[]): string {
  const out: string[] = [];
  let day = '';
  for (const r of rows) {
    const txt = (r.text || '').trim();
    if (!txt || (r.role === 'assistant' && txt === '__IGNORE__')) continue;
    const d = dayOf(r.created_at);
    if (d !== day) {
      day = d;
      const [y, m, dd] = d.split('-').map(Number);
      const label = new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US',
        { timeZone: 'UTC', weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
      out.push(`${out.length ? '\n' : ''}=== ${label} (${d}) ===`);
    }
    const when = new Date(r.created_at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    let who = r.role === 'user' ? 'You' : 'Assistant';
    if (r.role === 'assistant' && r.session_id) who = `Session "${r.session_label || r.session_id}" (${r.session_id})`;
    out.push(r.ignored && r.role === 'user'
      ? `[${when}] You (ignored as room noise, not acted on): ${txt}`
      : `[${when}] ${who}: ${txt}`);
  }
  return out.join('\n');
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The hub conversation between `from` and `to` (conversation days, inclusive), optionally only the
 * messages containing `query`. With neither a day nor a query it reads yesterday.
 */
export async function readConversation(a: { from?: string; to?: string; query?: string; limit?: number }): Promise<string> {
  const query = (a.query || '').trim();
  for (const k of ['from', 'to'] as const) {
    if (a[k] && !DAY.test(a[k]!)) return `${k} must be a day, YYYY-MM-DD.`;
  }
  let from = a.from, to = a.to;
  if (!from && !to && !query) from = to = addDays(dayOf(new Date().toISOString()), -1);
  if (from && !to) to = from;
  if (to && !from && !query) from = to;
  const limit = Math.min(Math.max(Math.trunc(Number(a.limit) || (query ? 50 : 300)), 1), 500);

  let q = getClient().from('voice_messages')
    .select('role,text,created_at,ignored,session_id,session_label')
    .eq('focus', 'hub').or('mode.is.null,mode.eq.hub').in('role', ['user', 'assistant']).eq('done', true);
  if (from) q = q.gte('created_at', dayStartUtc(from).toISOString());
  if (to) q = q.lt('created_at', dayStartUtc(addDays(to, 1)).toISOString());
  if (query) q = q.ilike('text', `%${query.replace(/[%_\\]/g, m => '\\' + m)}%`);
  // Newest first so the limit keeps the most recent, then printed oldest first.
  const { data, error } = await q.order('created_at', { ascending: false }).limit(limit + 1);
  if (error) throw new Error(`voice_messages: ${error.message}`);
  const more = (data?.length ?? 0) > limit;
  const rows = (data ?? []).slice(0, limit).reverse() as Row[];

  const span = from ? (from === to ? from : `${from} to ${to}`) : (to ? `everything up to ${to}` : 'all history');
  const what = query ? `messages containing "${query}" (${span})` : `the conversation on ${span}`;
  if (!rows.length) return `Nothing found: ${what}.`;
  let body = formatRows(rows);
  let cut = '';
  if (body.length > MAX_CHARS) {
    body = body.slice(body.length - MAX_CHARS);
    body = body.slice(body.indexOf('\n') + 1);
    cut = ' The start was cut for length; pass a narrower range for the rest.';
  }
  const older = more ? ` Older matching messages exist beyond these ${limit}; narrow the range or raise limit.` : '';
  const hint = query ? ' To see a match in its surroundings, call again with that day as `from` and no query.' : '';
  return `${what[0].toUpperCase()}${what.slice(1)}, oldest first. Words and final replies only; tool results were not kept.${older}${cut}${hint}\n\n${body}`;
}
