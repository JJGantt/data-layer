import { getClient } from './client.js';
import { ValidationError } from './helpers.js';
import { BUCKET } from './images.js';

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

type Row = { id: string; status: string; taps: number; typed: number; error: string | null; seq: number; note?: string | null;
  updated_at?: string };

/** How long realtime gets to deliver a change it could see before the backstop calls the channel deaf. */
export const DELIVERY_GRACE_MS = 2_000;

/** What a backstop read that found the row already there means. `deaf` (an error) only when the change
 *  landed at least JOIN_SETTLE_MS after the channel was SUBSCRIBED and then went DELIVERY_GRACE_MS with no
 *  event. A change made before that, or within the grace, is a race the backstop won (an occurrence): the
 *  drive path's 3 s backstop races a fresh channel's join on every step. */
export function backstopMiss(subscribedAt: number | null, updatedAt: string | undefined, now: number): 'deaf' | 'race' {
  if (subscribedAt == null) return 'race';
  const changed = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(changed)) return now - subscribedAt >= DELIVERY_GRACE_MS ? 'deaf' : 'race';
  // Realtime never replays a change made before the channel listened, and its listener is still settling
  // just after SUBSCRIBED: a change in that window is the subscribe-time read's to catch, not a deaf channel.
  if (changed < subscribedAt + JOIN_SETTLE_MS) return 'race';
  return now - changed >= DELIVERY_GRACE_MS ? 'deaf' : 'race';
}
/** How long after SUBSCRIBED a change may still be missed by a healthy channel. */
export const JOIN_SETTLE_MS = 1_500;

const ended = (r: Row) => r.status === 'done' || r.status === 'cancelled' || r.status === 'failed';

async function read(id: string): Promise<Row> {
  const { data, error } = await getClient().from('handoffs').select('id,status,taps,typed,error,seq,note,updated_at').eq('id', id).single();
  if (error) throw new Error(`could not read handoff ${id}: ${error.message}`);
  return data as Row;
}

/** Resolves with the row once `done` says so, however long that takes. `backstopMs` is the read behind
 *  the realtime subscription; a session driving a screen waits on it in seconds, not minutes. */
function until(id: string, done: (r: Row) => boolean, backstopMs = BACKSTOP_MS): Promise<Row> {
  return new Promise((resolve) => {
    const sb = getClient();
    let finished = false;
    let subscribedAt: number | null = null;
    let channelStatus = 'joining';
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
        channelStatus = status;
        // Read once subscribed, so an end that landed before the channel was up is not missed.
        if (status === 'SUBSCRIBED') {
          if (subscribedAt == null) subscribedAt = Date.now();
          read(id).then((r) => { if (done(r)) finish(r); })
            .catch((e) => { if (!finished) console.warn(`[handoff] read on subscribe failed (backstop retries): ${e.message}`); });
        }
      });
    const backstop = setInterval(() => {
      read(id).then((r) => {
        if (!done(r) || finished) return;
        if (backstopMiss(subscribedAt, r.updated_at, Date.now()) === 'deaf') {
          console.error(`[handoff] ${id} reached ${r.status} without its update arriving over realtime`);
        } else {
          console.warn(`[handoff] ${id} reached ${r.status} before realtime delivered it (channel ${channelStatus})`);
        }
        finish(r);
      }).catch((e) => { if (!finished) console.error(`[handoff] backstop read failed: ${e.message}`); });
    }, backstopMs);
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
  const sid = process.env.HUB_SESSION_ID;
  // A screen this session is already driving (drive_screen) is handed over in place: the same row becomes
  // his, with this note and framing, so his phone shows one handoff for one screen rather than a second
  // copy of it. A refresh takes the screenshot again with the new framing, and the phone picks up the
  // suggestions with it.
  if (sid) await supersede(sid);
  const drivenId = sid ? await drivenScreen(sid, target, f.app || null) : null;
  if (drivenId) {
    const busy = await screenBusy(target);
    const { data: h, error } = await getClient().from('handoffs')
      .update({ driver: null, ...(busy ? { status: 'queued' } : {}), note: note.slice(0, 300), region: reg || null, selector: f.selector || null,
        suggest: suggest.length ? suggest : null, updated_at: new Date().toISOString() })
      .eq('id', drivenId).eq('driver', 'session').in('status', ['new', 'open']).select('id,target,seq').maybeSingle();
    if (error) console.error(`[handoff] could not hand over driven screen ${drivenId}: ${error.message}`);
    if (h && busy) return QUEUED(h.id);
    if (h) {
      const { error: ins } = await getClient().from('handoff_actions')
        .insert({ handoff: h.id, target: h.target, seq: h.seq, full: true, source: 'session', kind: 'refresh' });
      if (ins) console.error(`[handoff] ${h.id} handed over, but its refresh failed: ${ins.message}`);
      return `Handed to Jared (handoff ${h.id}, the screen you were driving). End your turn now and do not wait for it: `
        + `when he presses Done or Cancel, a message starting "[Handoff ${h.id}]" arrives saying how it ended, and that starts your next turn.`;
    }
    // It ended between the read and the update: a new handoff follows.
  }
  const { data, error } = await getClient().from('handoffs')
    .insert({ target, note: note.slice(0, 300), session: sid || null,
      app: f.app || null, region: reg || null, selector: f.selector || null, suggest: suggest.length ? suggest : null })
    .select('id').single();
  if (error) throw new Error(`could not open the handoff: ${error.message}`);
  if (!sid) return endedMessage(await until(data.id, ended));
  // Up on his phone (or failed before it got there): that is all the session waits for.
  const r = await until(data.id, (x) => x.status !== 'new');
  if (ended(r)) return endedMessage(r);
  if (r.status === 'queued') return QUEUED(data.id);
  return `Handed to Jared (handoff ${data.id}). End your turn now and do not wait for it: when he presses Done or `
    + `Cancel, a message starting "[Handoff ${data.id}]" arrives saying how it ended, and that starts your next turn.`;
}

/**
 * A session waits on one thing from Jared at a time, so a new ask (or driving that screen again) retires
 * every earlier one still open: he answered it some other way (at the Mac itself, most often) or the session
 * moved on, and left open it sits on his phone until it expires. Ended silently, since the session asking
 * again already knows. `target` narrows it to the asks on one screen.
 */
async function supersede(session: string, target?: string): Promise<void> {
  const why = 'superseded: the session asked again';
  let q = getClient().from('handoffs').select('id,target,seq,status').eq('session', session).is('driver', null)
    .in('status', ['new', 'queued', 'open']);
  if (target) q = q.eq('target', target);
  const { data, error } = await q;
  if (error) { console.error(`[handoff] could not read session ${session}'s earlier handoffs: ${error.message}`); return; }
  for (const h of data || []) {
    // An open one ends through its agent, which is what opens the next queued handoff on that screen; a
    // cancel from the session is not reported back to it. One not on screen yet is simply ended.
    const { error: e } = h.status === 'open'
      ? await getClient().from('handoff_actions').insert({ handoff: h.id, target: h.target, seq: h.seq, source: 'session', kind: 'cancel', text: why })
      : await getClient().from('handoffs').update({ status: 'cancelled', error: why, suggest: null, updated_at: new Date().toISOString() })
        .eq('id', h.id).in('status', ['new', 'queued']);
    if (e) console.error(`[handoff] could not retire handoff ${h.id}: ${e.message}`);
  }
}

/** Whether another ask is open on the same physical screen (both Mac targets are the Mac's display). */
async function screenBusy(target: string): Promise<boolean> {
  const same = target.startsWith('mac-') ? ['mac-screen', 'mac-chrome'] : [target];
  const { data, error } = await getClient().from('handoffs').select('id').is('driver', null).eq('status', 'open').in('target', same).limit(1);
  if (error) { console.error(`[handoff] could not read the open handoffs on ${target}: ${error.message}`); return false; }
  return !!data?.length;
}

const QUEUED = (id: string) => `Queued (handoff ${id}): another session's handoff is open on that screen, and this one goes to Jared `
  + `when that one ends. End your turn now and do not wait for it: a message starting "[Handoff ${id}]" arrives when he finishes.`;

/** The newest screen this session is driving on that target (and app), still open, or null. */
async function drivenScreen(session: string, target: string, app: string | null): Promise<string | null> {
  let q = getClient().from('handoffs').select('id').eq('session', session).eq('driver', 'session')
    .eq('target', target).in('status', ['new', 'open']);
  q = app ? q.eq('app', app) : q.is('app', null);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1);
  if (error) { console.error(`[handoff] could not look for a screen this session drives: ${error.message}`); return null; }
  return data?.[0]?.id || null;
}

/** How a handoff ended, as the session is told it: the follow-up the agent sends, or the reply to a waiting call. */
export function endedMessage(r: Row & { note?: string | null }): string {
  const did = `${r.taps} tap${r.taps === 1 ? '' : 's'}${r.typed ? `, typed ${r.typed} time${r.typed === 1 ? '' : 's'}` : ''}`;
  const what = r.note ? ` ("${r.note}")` : '';
  if (r.status === 'done') return `[Handoff ${r.id}] Jared finished${what} (${did}). Look at the screen again to see where it stands, then carry on.`;
  if (r.status === 'cancelled' && /^expired/.test(r.error || '')) return `[Handoff ${r.id}] The handoff${what} expired with no answer from Jared (${did}). Look at the screen to see whether it was done another way.`;
  if (r.status === 'cancelled') return `[Handoff ${r.id}] Jared cancelled the handoff${what} (${did}). Do not ask again unless he says to.`;
  return `[Handoff ${r.id}] The handoff failed${what}: ${r.error || 'no reason given'} (${did}).`;
}

/** Sent to the asking session once his input on an open ask goes quiet (handoffAgent `nudge`). */
export function activityMessage(r: { id: string; taps: number; typed: number; note?: string | null }): string {
  const did = `${r.taps} tap${r.taps === 1 ? '' : 's'}${r.typed ? `, typed ${r.typed} time${r.typed === 1 ? '' : 's'}` : ''}`;
  const what = r.note ? ` ("${r.note}")` : '';
  return `[Handoff ${r.id}] Jared has been working the handoff${what} and has paused (${did} so far); it is still open. ` +
    `Look at the screen now (drive_screen look with this id, or your Chrome tools on his Chrome). If the step is done, ` +
    `end the handoff yourself with drive_screen close and this id and carry on; never ask him to press Done or to tell you. ` +
    `If it is not done yet, end your turn without replying: another message comes when he pauses again.`;
}

// DRIVING A SCREEN — a session uses the same agents to work a screen itself, with nobody in the loop.
//
// The Mac's screen (a Terminal, his Chrome, any app) answers handoffs from every machine, Fly included,
// because the agent on the Mac listens to Supabase rather than to a port. drive_screen opens a handoff
// with driver 'session'. The hub still pushes it, so he sees a session working that screen and can watch,
// but the agent tells no session it ended: the session that drives it is the one that closes it. Each step waits for the agent's next screenshot
// and returns it, so the caller sees what its action did.

export type DriveOp = 'open' | 'look' | 'tap' | 'type' | 'key' | 'close';
export const DRIVE_KEYS = ['enter', 'tab', 'backspace', 'escape'] as const;

/** How long a step may take before the caller is told the agent did not answer. */
const STEP_MS = 30_000;
/** A screenshot that changed nothing still arrives; this is only the read behind realtime. */
const DRIVE_BACKSTOP_MS = 3_000;

export interface Shot { id: string; seq: number; status: string; error: string | null; width: number;
  height: number; idle_s: number | null; png: Buffer | null;
  /** Set when the agent refused the step (the screen changed under a tap): it was NOT done. */
  dropped?: string; }

async function shot(id: string): Promise<Shot> {
  const { data: r, error } = await getClient().from('handoffs')
    .select('id,seq,status,error,full_image,width,height,idle_s').eq('id', id).single();
  if (error || !r) throw new Error(`could not read handoff ${id}: ${error?.message}`);
  let png: Buffer | null = null;
  if (r.full_image) {
    const { data, error: dl } = await getClient().storage.from(BUCKET).download(r.full_image);
    if (dl) throw new Error(`could not fetch screenshot ${r.full_image}: ${dl.message}`);
    png = Buffer.from(await data.arrayBuffer());
  }
  return { id: r.id, seq: r.seq || 0, status: r.status, error: r.error, width: r.width, height: r.height, idle_s: r.idle_s, png };
}

function within<T>(p: Promise<T>, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, no) => { t = setTimeout(() => no(new Error(`${what}: no answer from the screen's agent in ${STEP_MS / 1000}s (is the Mac awake?)`)), STEP_MS); })])
    .finally(() => clearTimeout(t));
}

export async function driveScreen(op: DriveOp, a: { id?: string; target?: string; app?: string; x?: number; y?: number;
  text?: string; key?: string; note?: string }): Promise<Shot> {
  if (op === 'open') {
    const target = a.target || '';
    if (!(TARGETS as readonly string[]).includes(target)) throw new ValidationError(`target must be one of ${TARGETS.join(', ')}`);
    if (target === 'mac-screen' && !a.app) throw new ValidationError('mac-screen needs `app`: the app to bring to the front (its owner name, e.g. Terminal)');
    const sid = process.env.HUB_SESSION_ID;
    if (sid) await supersede(sid, target);
    const { data, error } = await getClient().from('handoffs').insert({ target, app: a.app || null, driver: 'session',
      note: (a.note || 'Driven by a session').slice(0, 300), session: sid || null }).select('id').single();
    if (error) throw new Error(`could not open the screen: ${error.message}`);
    const r = await within(until(data.id, (x) => x.status !== 'new', DRIVE_BACKSTOP_MS), 'open');
    if (r.status === 'failed') throw new Error(`the screen could not be opened: ${r.error}`);
    return shot(data.id);
  }
  if (!a.id) throw new ValidationError('`id` is required: the handoff id that open returned');
  const { data: h, error } = await getClient().from('handoffs').select('id,target,seq,status,driver,session').eq('id', a.id).single();
  if (error || !h) throw new ValidationError(`no handoff ${a.id}`);
  // A handoff this session gave him can be looked at and ended by it too: when the session can see the step
  // is done (a file written, a page moved on), it closes the handoff rather than asking him to press Done.
  const ownHandoff = (op === 'close' || op === 'look') && !!h.session && h.session === process.env.HUB_SESSION_ID;
  if (h.driver !== 'session' && !ownHandoff) throw new ValidationError(`handoff ${a.id} was handed to Jared; drive only a screen you opened with drive_screen`);
  if (['done', 'cancelled', 'failed'].includes(h.status)) throw new ValidationError(`handoff ${a.id} has already ended (${h.status}); open a new one`);
  const row: Record<string, unknown> = { handoff: h.id, target: h.target, seq: h.seq, full: true, source: 'session' };
  if (op === 'close') row.kind = 'done';
  else if (op === 'look') row.kind = 'refresh';
  else if (op === 'tap') {
    if (![a.x, a.y].every((v) => typeof v === 'number' && v >= 0 && v <= 1)) throw new ValidationError('tap needs `x` and `y`, fractions 0-1 of the latest screenshot');
    Object.assign(row, { kind: 'tap', x: a.x, y: a.y });
  } else if (op === 'type') {
    if (!a.text) throw new ValidationError('type needs `text`');
    Object.assign(row, { kind: 'text', text: a.text });
  } else if (op === 'key') {
    if (!(DRIVE_KEYS as readonly string[]).includes(a.key || '')) throw new ValidationError(`key must be one of ${DRIVE_KEYS.join(', ')}`);
    Object.assign(row, { kind: 'key', key: a.key });
  } else throw new ValidationError('op must be open, look, tap, type, key or close');
  const { data: act, error: ins } = await getClient().from('handoff_actions').insert(row).select('id').single();
  if (ins) throw new Error(`could not send the ${op}: ${ins.message}`);
  const r = await within(until(h.id, (x) => (x.seq || 0) > h.seq || ended(x), DRIVE_BACKSTOP_MS), op);
  if (op === 'close') return { ...(await shot(h.id)), png: null };
  if (r.status === 'failed') throw new Error(`the screen failed: ${r.error}`);
  // A new screenshot arrives whether the step was done or refused; only the action row says which.
  const { data: done } = await getClient().from('handoff_actions').select('error').eq('id', act.id).single();
  const s = await shot(h.id);
  return done?.error ? { ...s, dropped: done.error } : s;
}
