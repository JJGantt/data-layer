import { getClient } from './client.js';

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
        (p: any) => { handle(p.new).catch((e) => console.log(`[${table}] handler failed`, e.message)); })
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
