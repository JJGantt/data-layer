import { hostname } from 'node:os';
import { getClient } from './client.js';

// One answerer per row, however many machines subscribe: the first to set claimed_by acts, and the rest
// see the row already taken. The table needs a nullable `claimed_by` column (00155).
async function claim(table: string, row: any): Promise<boolean> {
  const { data, error } = await getClient().from(table).update({ claimed_by: hostname() })
    .eq('id', row.id).is('claimed_by', null).select('id');
  if (error) throw new Error(`claim failed: ${error.message}`);
  if (!data?.length) { console.log(`[${table}] ${row.id} claimed elsewhere`); return false; }
  return true;
}

/** Call `handle` for every INSERT on `table`, for the life of the process. A channel that errors or
 *  closes is replaced, with backoff doubling to a minute, so a Supabase outage costs one attempt a
 *  minute rather than a loop.
 *
 *  `deferMs` makes this machine the fallback: it waits that long before claiming, so a primary that is
 *  up has always claimed the row first and this one finds it taken. A row it does win is one the
 *  primary never took, which is reported as an error, since it means the primary is down.
 *
 *  Behind the subscription, a slow backstop (`sweepMissed`, every MISSED_SWEEP_MS) finds rows nobody
 *  claimed — every row is claimed by whichever machine answers it, so an unclaimed one means no machine
 *  heard it — and reports each once. It does not act on them: a TV command or a read minutes late is
 *  worse than none, and its caller has already given up. */
export function onInserts(table: string, handle: (row: any) => Promise<void>, deferMs = 0): void {
  // Ids this process received, by when, so the sweep can tell a deaf channel from a quiet table.
  const heard = new Map<string, number>();
  let subscribedAt = 0;
  let recycle: (() => void) | null = null;
  const take = async (row: any) => {
    heard.set(row.id, Date.now());
    if (deferMs) await new Promise((r) => setTimeout(r, deferMs));
    if (!(await claim(table, row))) return;
    if (deferMs) console.error(`[${table}] ${row.id} (${row.op || row.kind}) unclaimed after ${deferMs / 1000}s: answering it here, the primary is not`);
    await handle(row);
  };
  let backoff = 1000;
  const connect = () => {
    const sb = getClient();
    let replaced = false;
    const ch = sb.channel(`inserts-${table}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table },
        (p: any) => { take(p.new).catch((e) => console.error(`[${table}] handler failed`, e.message)); })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { backoff = 1000; subscribedAt = Date.now(); console.log(`[${table}] subscribed`); return; }
        if (!replaced && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
          replaced = true;  // removeChannel reports CLOSED too; reconnect once per channel
          subscribedAt = 0;
          sb.removeChannel(ch);
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      });
    recycle = () => { if (!replaced) { replaced = true; subscribedAt = 0; sb.removeChannel(ch); setTimeout(connect, 1000); } };
  };
  connect();
  // A Mac wake fires this overdue timer before the network is back, so one failed sweep is a warning;
  // a sweep still failing SWEEP_RAISE_MS after the first failure (the next one) is the error.
  let failingSince = 0;
  let raised = false;
  setInterval(async () => {
    try {
      await sweepMissed(table);
      failingSince = 0; raised = false;
      const now = Date.now();
      for (const [id, at] of heard) if (at < now - MISSED_WINDOW_MS) heard.delete(id);
      if (!subscribedAt) return;
      const unheard = await sweepUnheard(table, heard, subscribedAt, now);
      if (!unheard.length) return;
      console.error(`[${table}] channel deaf while SUBSCRIBED: never received ${unheard.join(', ')}; resubscribing`);
      recycle?.();
    } catch (e: any) {
      const now = Date.now();
      failingSince ||= now;
      if (!raised && now - failingSince >= SWEEP_RAISE_MS) {
        raised = true;
        console.error(`[${table}] missed-row sweep failing since ${new Date(failingSince).toISOString()}:`, e.message);
      } else console.warn(`[${table}] missed-row sweep failed (will retry):`, e.message);
    }
  }, MISSED_SWEEP_MS);
}

/** Rows inserted since this channel subscribed (and old enough to have arrived) that it never received.
 *  sweepMissed only sees a row NO machine claimed, so a deaf fallback behind a healthy Pi would stay
 *  deaf unnoticed; this is each process checking its own hearing. */
export async function sweepUnheard(table: string, heard: Map<string, number>, since: number, now = Date.now()): Promise<string[]> {
  const from = Math.max(since, now - MISSED_WINDOW_MS);
  const to = now - MISSED_AFTER_MS;
  if (from >= to) return [];
  const { data, error } = await getClient().from(table).select('id')
    .gt('created_at', new Date(from).toISOString()).lt('created_at', new Date(to).toISOString());
  if (error) throw new Error(error.message);
  return (data || []).map((r: any) => r.id).filter((id: string) => !heard.has(id));
}

// Minutes, as a backstop must be. A row is "missed" once it is older than any claim could take (the Mac
// defers 4 s), and rows older than the window were already swept or predate this process.
const MISSED_SWEEP_MS = 10 * 60_000;
const MISSED_AFTER_MS = 60_000;
const MISSED_WINDOW_MS = MISSED_SWEEP_MS + 5 * 60_000;
const SWEEP_RAISE_MS = 5 * 60_000;

export async function sweepMissed(table: string, now = Date.now()): Promise<number> {
  const sb = getClient();
  const { data, error } = await sb.from(table).select('id, created_at').is('claimed_by', null)
    .lt('created_at', new Date(now - MISSED_AFTER_MS).toISOString())
    .gt('created_at', new Date(now - MISSED_WINDOW_MS).toISOString());
  if (error) throw new Error(error.message);
  let n = 0;
  for (const row of data || []) {
    // Claimed as missed, so it is reported once whichever machines sweep, and never acted on later.
    const { data: won } = await sb.from(table).update({ claimed_by: `${hostname()}:missed` })
      .eq('id', row.id).is('claimed_by', null).select('id');
    if (!won?.length) continue;
    n++;
    console.error(`[${table}] ${row.id} from ${row.created_at} was never claimed: no machine heard it (realtime deaf or every agent down)`);
  }
  return n;
}
