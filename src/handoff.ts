import { getClient } from './client.js';
import { ValidationError } from './helpers.js';

// HANDOFFS — a session stuck on something only Jared can do hands him the screen it is stuck on.
//
// The session calls request_handoff with the screen (`target`) and a line saying what it needs. The
// agent on the machine that owns that screen (handoffAgent.ts) screenshots it; the hub pushes it to his
// phone and puts it on the session's view on the phone and the watch (status-hub routes/handoffs.js).
// He taps on the screenshot, or types, and the agent clicks or types at that spot on the real screen,
// then screenshots again, until he presses Done or Cancel. This call is held open for all of it and
// answers with how it ended.
//
// What he types goes from his device to the agent and is cleared once typed: it never reaches the
// session, which is told only how many times he typed.

export const TARGETS = ['mac-screen', 'mac-chrome', 'pi-browser'] as const;
export type Target = typeof TARGETS[number];

/** Backstop behind the realtime subscription: a channel can go deaf while reporting SUBSCRIBED. */
const BACKSTOP_MS = 2 * 60_000;

type Row = { id: string; status: string; taps: number; typed: number; error: string | null; seq: number };

const ended = (r: Row) => r.status === 'done' || r.status === 'cancelled' || r.status === 'failed';

async function read(id: string): Promise<Row> {
  const { data, error } = await getClient().from('handoffs').select('id,status,taps,typed,error,seq').eq('id', id).single();
  if (error) throw new Error(`could not read handoff ${id}: ${error.message}`);
  return data as Row;
}

/** Resolves with the row once it has ended, however long he takes. */
function untilEnded(id: string): Promise<Row> {
  return new Promise((resolve) => {
    const sb = getClient();
    let finished = false;
    const finish = (r: Row) => {
      if (finished) return;
      finished = true;
      clearInterval(backstop);
      sb.removeChannel(ch);
      resolve(r);
    };
    const ch = sb.channel(`handoff-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'handoffs', filter: `id=eq.${id}` },
        (p: any) => { if (ended(p.new)) finish(p.new); })
      .subscribe((status) => {
        // Read once subscribed, so an end that landed before the channel was up is not missed.
        if (status === 'SUBSCRIBED') read(id).then((r) => { if (ended(r)) finish(r); }).catch(() => {});
      });
    const backstop = setInterval(() => {
      read(id).then((r) => {
        if (!ended(r) || finished) return;
        console.error(`[handoff] ${id} ended (${r.status}) without its update arriving over realtime`);
        finish(r);
      }).catch((e) => { if (!finished) console.error(`[handoff] backstop read failed: ${e.message}`); });
    }, BACKSTOP_MS);
  });
}

export async function requestHandoff(target: string, note: string): Promise<string> {
  if (!(TARGETS as readonly string[]).includes(target)) {
    throw new ValidationError(`target must be one of ${TARGETS.join(', ')}`);
  }
  const { data, error } = await getClient().from('handoffs')
    .insert({ target, note: note.slice(0, 300), session: process.env.HUB_SESSION_ID || null })
    .select('id').single();
  if (error) throw new Error(`could not open the handoff: ${error.message}`);
  const r = await untilEnded(data.id);
  const did = `${r.taps} tap${r.taps === 1 ? '' : 's'}${r.typed ? `, typed ${r.typed} time${r.typed === 1 ? '' : 's'}` : ''}`;
  if (r.status === 'done') return `Jared finished (${did}). Look at the screen again to see where it stands, then carry on.`;
  if (r.status === 'cancelled') return `Jared cancelled the handoff (${did}). Do not ask again unless he says to.`;
  return `The handoff failed: ${r.error || 'no reason given'} (${did}).`;
}
