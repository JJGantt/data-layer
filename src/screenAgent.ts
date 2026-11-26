/**
 * The screen agent: answers a live screen share (status-hub docs/SCREEN.md) on the Mac.
 *
 * The phone's offer arrives as a `screen_shares` row (inserted by the hub). This claims it, starts
 * hands/bin/screenshare with the offer — ScreenCaptureKit, hardware H.264 and WebRTC, plus his taps and
 * typing posted as events — and writes back the answer, then the connection's path, and at the end why it
 * ended and the sending counters. The helper ends itself (the phone's "bye", a connection gone for 10 s,
 * none made within 30 s), so nothing here waits on it beyond reading what it prints.
 *
 * It runs inside the handoff agent's process (handoffMain.ts), under hands-launch, because the helper
 * needs the Screen Recording and Accessibility grants that launcher holds. A screen exists on one
 * machine, so there is no fallback: a share asked of a Mac that is asleep is never claimed, and the hub
 * tells the phone so when no answer comes.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';

const BIN = process.env.SCREENSHARE_BIN || path.join(process.cwd(), 'hands/bin/screenshare');
/** Each share is its own capture and encoder; more than this at once is a phone that lost track of one. */
const MAX_LIVE = 3;
/** Ways a share ends that are nobody's failure. */
const NORMAL = new Set(['bye', 'stopped', 'disconnected', 'closed']);

const live = new Map<string, ChildProcess>();

async function update(id: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await getClient().from('screen_shares').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) console.error(`[screen] ${id}: could not update the row: ${error.message}`);
}

async function share(row: any): Promise<void> {
  const id: string = row.id;
  const t0 = Date.parse(row.created_at) || Date.now();
  if (live.size >= MAX_LIVE) {
    console.error(`[screen] ${id}: refused, ${live.size} shares already live`);
    await update(id, { status: 'failed', error: `${live.size} shares already live` });
    return;
  }
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  live.set(id, child);
  let ended = false;
  child.on('error', (e) => console.error(`[screen] ${id}: could not start ${BIN}: ${e.message}`));
  child.stdin!.on('error', () => {});
  child.stdin!.write(JSON.stringify({ offer: row.offer, ice: row.ice || [] }) + '\n');
  createInterface({ input: child.stderr! }).on('line', (l) => console.log(`[screen] ${id.slice(0, 8)} ${l}`));
  createInterface({ input: child.stdout! }).on('line', (l) => {
    let m: any;
    try { m = JSON.parse(l); } catch { return; }
    if (m.answer) update(id, { status: 'answered', answer: m.answer });
    else if (m.connected) {
      console.log(`[screen] ${id.slice(0, 8)} connected over ${m.path} after ${Date.now() - t0} ms`);
      update(id, { status: 'live', path: m.path, connect_ms: Date.now() - t0 });
    } else if (m.first_frame_ms != null) update(id, { first_frame_ms: m.first_frame_ms });
    else if (m.end) {
      ended = true;
      const ok = NORMAL.has(m.end);
      if (!ok) console.error(`[screen] ${id}: share ended: ${m.end}`);
      update(id, { status: ok ? 'ended' : 'failed', ended_reason: m.end, ...(ok ? {} : { error: m.end }), stats: m.stats || null });
    }
  });
  child.on('exit', (code, sig) => {
    live.delete(id);
    if (ended) return;
    console.error(`[screen] ${id}: screenshare exited without saying why (code ${code}, signal ${sig})`);
    update(id, { status: 'failed', error: `screenshare exited ${code ?? sig}` });
  });
}

/** Answer every screen share for this machine, for the life of the process. */
export function start(): void {
  onInserts('screen_shares', share, 0, (row) => row.target === 'mac' && row.status === 'new');
  console.log('[screen-agent] answering screen shares');
}
