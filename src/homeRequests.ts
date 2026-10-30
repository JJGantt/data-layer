// Reads only the Pi can answer (migration 00138). `ask` is the caller's side, from any machine;
// `start` is the Pi's, run by data-http when HOME_AGENT=1. Realtime both ways, like tv_commands.
import { randomUUID } from 'crypto';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';
import * as youtubeAccount from './youtubeAccount.js';

// A deep history or the full subscription list is several YouTube round trips from the Pi.
const TIMEOUT_MS = 60_000;

export async function ask(kind: string, args: Record<string, unknown>): Promise<string> {
  const sb = getClient();
  const id = randomUUID();
  return new Promise<string>((resolve) => {
    const ch = sb.channel(`home-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'home_requests', filter: `id=eq.${id}` },
        (p: any) => {
          if (!p.new?.done_at) return;
          sb.removeChannel(ch);
          const r = p.new.result || {};
          resolve(r.ok ? String(r.text) : `Failed: ${r.error || 'no reason given'}`);
        })
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        const { error } = await sb.from('home_requests').insert({ id, kind, args });
        if (error) { sb.removeChannel(ch); resolve(`Failed: ${error.message}`); }
      });
    setTimeout(() => { sb.removeChannel(ch); resolve('Failed: the Pi did not answer in 60s (data-http down, or its browser).'); }, TIMEOUT_MS);
  });
}

async function answer(row: any): Promise<void> {
  if (row.done_at) return;
  let result: Record<string, unknown>;
  try {
    if (row.kind !== 'youtube_account') throw new Error(`unknown kind ${row.kind}`);
    const op = String(row.args?.op) as youtubeAccount.Op;
    if (!youtubeAccount.OPS.includes(op)) throw new Error(`unknown op ${op}`);
    result = { ok: true, text: await youtubeAccount.account(op, row.args || {}) };
  } catch (e: any) {
    result = { ok: false, error: String(e.message || e) };
  }
  const { error } = await getClient().from('home_requests').update({ done_at: new Date().toISOString(), result }).eq('id', row.id);
  if (error) console.log('[home] answer failed', error.message);
}

export const start = () => onInserts('home_requests', answer);
