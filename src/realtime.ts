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
 *  minute rather than a loop. */
export function onInserts(table: string, handle: (row: any) => Promise<void>): void {
  let backoff = 1000;
  const connect = () => {
    const sb = getClient();
    let replaced = false;
    const ch = sb.channel(`inserts-${table}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table },
        (p: any) => { claim(table, p.new).then((mine) => { if (mine) return handle(p.new); })
          .catch((e) => console.error(`[${table}] handler failed`, e.message)); })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { backoff = 1000; console.log(`[${table}] subscribed`); return; }
        if (!replaced && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
          replaced = true;  // removeChannel reports CLOSED too; reconnect once per channel
          sb.removeChannel(ch);
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      });
  };
  connect();
}
