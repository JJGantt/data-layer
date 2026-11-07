// THE CAT FEEDER — a PetLibro (Tuya) feeder reachable only on the home LAN (petlibro-mcp CLAUDE.md).
//
// A feed is a feeder_commands row (00035). The Pi's petlibro-collector wakes on the insert, dispenses,
// and marks the row `done` once the feeder's own last-feed log confirms it, or `failed` with why. This
// waits for that update on a realtime subscription rather than polling, so the tool works from any
// machine — Fly included, where the feeder itself is unreachable.
import { randomUUID } from 'crypto';
import { getClient } from './client.js';

// A dispense cycle is ~25 s before the feeder logs it, and the collector confirms after that.
const TIMEOUT_MS = 75_000;

export async function feed(portions: number, source = 'data-mcp'): Promise<string> {
  const n = Math.max(1, Math.min(12, Math.round(portions) || 1));
  const sb = getClient();
  const id = randomUUID();
  let last: any = null;
  // Subscribed BEFORE the insert, so an answer faster than the subscription cannot be missed.
  const row = await new Promise<any>((resolve) => {
    const ch = sb.channel(`feed-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'feeder_commands', filter: `id=eq.${id}` },
        (p: any) => { last = p.new; if (p.new.status !== 'pending') { sb.removeChannel(ch); resolve(p.new); } })
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        const { error } = await sb.from('feeder_commands').insert({ id, action: 'feed', portions: n, source, status: 'pending' });
        if (error) { sb.removeChannel(ch); resolve({ status: 'failed', result: `insert failed: ${error.message}` }); }
      });
    setTimeout(() => { sb.removeChannel(ch); resolve(last); }, TIMEOUT_MS);
  });
  if (row?.status === 'done') return `Fed ${n} portion${n === 1 ? '' : 's'}; the feeder confirmed it.`;
  if (row?.status === 'failed') {
    console.error(`[feeder] feed ${id} failed: ${row.result}`);
    return `The feed FAILED: ${row.result || 'no reason given'}.`;
  }
  console.error(`[feeder] feed ${id} unanswered after ${TIMEOUT_MS / 1000}s`);
  return `Feed requested, but the Pi's feeder collector did not confirm it within ${TIMEOUT_MS / 1000}s — it may still dispense, or the collector may be down.`;
}
