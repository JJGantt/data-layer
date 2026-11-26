import { getClient } from './client.js';
import { ValidationError } from './helpers.js';

// HANDOFFS — a session stuck on something only Jared can do hands him the screen it is stuck on.
//
// The session calls request_handoff with the screen (`target`) and a line saying what it needs. The
// agent on the machine that owns that screen (handoffAgent.ts) screenshots it; the hub pushes it to his
// phone and puts it on the session's view on the phone and the watch (status-hub routes/handoffs.js).
// He taps on the screenshot, or types, and the agent clicks or types at that spot on the real screen,
// then screenshots again, until he presses Done or Cancel.
//
// NOTHING WAITS FOR HIM. The call returns as soon as the screenshot is up, and the session ends its turn.
// When he presses Done or Cancel (or the handoff fails), the agent sends the session a follow-up saying
// how it ended (`endedMessage`, sent by handoffAgent.ts), and that message is what starts its next turn.
// A tool call held open until he finished was killed by Claude Code's 30-minute idle limit, left the
// handoff open with nobody waiting on it, and blocked the session for as long as he took. Only a caller
// with no session to wake (no HUB_SESSION_ID) still waits for the end.
//
// What he types goes from his device to the agent and is cleared once typed: it never reaches the
// session, which is told only how many times he typed.

export const TARGETS = ['mac-screen', 'mac-chrome', 'pi-browser'] as const;
export type Target = typeof TARGETS[number];

/** Backstop behind the realtime subscription: a channel can go deaf while reporting SUBSCRIBED. */
const BACKSTOP_MS = 2 * 60_000;

type Row = { id: string; status: string; taps: number; typed: number; error: string | null; seq: number; note?: string | null };

const ended = (r: Row) => r.status === 'done' || r.status === 'cancelled' || r.status === 'failed';

async function read(id: string): Promise<Row> {
  const { data, error } = await getClient().from('handoffs').select('id,status,taps,typed,error,seq,note').eq('id', id).single();
  if (error) throw new Error(`could not read handoff ${id}: ${error.message}`);
  return data as Row;
}

/** Resolves with the row once `done` says so, however long that takes. */
function until(id: string, done: (r: Row) => boolean): Promise<Row> {
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
        (p: any) => { if (done(p.new)) finish(p.new); })
      .subscribe((status) => {
        // Read once subscribed, so an end that landed before the channel was up is not missed.
        if (status === 'SUBSCRIBED') read(id).then((r) => { if (done(r)) finish(r); }).catch(() => {});
      });
    const backstop = setInterval(() => {
      read(id).then((r) => {
        if (!done(r) || finished) return;
        console.error(`[handoff] ${id} reached ${r.status} without its update arriving over realtime`);
        finish(r);
      }).catch((e) => { if (!finished) console.error(`[handoff] backstop read failed: ${e.message}`); });
    }, BACKSTOP_MS);
  });
}

export interface Framing {
  /** mac-screen: the app whose front window is shown (its owner name, as `hands windows` lists it). */
  app?: string;
  /** The part of the screen (Mac) or page (browser) that matters, as fractions: a sign-in dialog, not the whole screen. */
  region?: { x: number; y: number; w: number; h: number };
  /** pi-browser: the element to show (plus a margin), followed as the page changes. */
  selector?: string;
  /** Values he will type that the session already knows (his email, a card number), each a button on
   *  the phone that fills the text box; he still presses Type. Cleared from the row when it ends. */
  suggest?: { label: string; text: string }[];
}

export async function requestHandoff(target: string, note: string, f: Framing = {}): Promise<string> {
  if (!(TARGETS as readonly string[]).includes(target)) {
    throw new ValidationError(`target must be one of ${TARGETS.join(', ')}`);
  }
  if (target === 'mac-screen' && !f.app) throw new ValidationError('mac-screen needs `app`: the app whose window to show');
  const reg = f.region;
  if (reg && ![reg.x, reg.y, reg.w, reg.h].every((v) => typeof v === 'number' && v >= 0 && v <= 1)) {
    throw new ValidationError('region is {x, y, w, h}, each a fraction 0-1 of the screen (Mac) or page (browser)');
  }
  const suggest = (f.suggest || []).filter((v) => v && typeof v.text === 'string' && v.text)
    .slice(0, 8).map((v) => ({ label: String(v.label || v.text).slice(0, 40), text: v.text.slice(0, 500) }));
  const { data, error } = await getClient().from('handoffs')
    .insert({ target, note: note.slice(0, 300), session: process.env.HUB_SESSION_ID || null,
      app: f.app || null, region: reg || null, selector: f.selector || null, suggest: suggest.length ? suggest : null })
    .select('id').single();
  if (error) throw new Error(`could not open the handoff: ${error.message}`);
  if (!process.env.HUB_SESSION_ID) return endedMessage(await until(data.id, ended));
  // Up on his phone (or failed before it got there): that is all the session waits for.
  const r = await until(data.id, (x) => x.status !== 'new');
  if (ended(r)) return endedMessage(r);
  return `Handed to Jared (handoff ${data.id}). End your turn now and do not wait for it: when he presses Done or `
    + `Cancel, a message starting "[Handoff ${data.id}]" arrives saying how it ended, and that starts your next turn.`;
}

/** How a handoff ended, as the session is told it: the follow-up the agent sends, or the reply to a waiting call. */
export function endedMessage(r: Row & { note?: string | null }): string {
  const did = `${r.taps} tap${r.taps === 1 ? '' : 's'}${r.typed ? `, typed ${r.typed} time${r.typed === 1 ? '' : 's'}` : ''}`;
  const what = r.note ? ` ("${r.note}")` : '';
  if (r.status === 'done') return `[Handoff ${r.id}] Jared finished${what} (${did}). Look at the screen again to see where it stands, then carry on.`;
  if (r.status === 'cancelled') return `[Handoff ${r.id}] Jared cancelled the handoff${what} (${did}). Do not ask again unless he says to.`;
  return `[Handoff ${r.id}] The handoff failed${what}: ${r.error || 'no reason given'} (${did}).`;
}
