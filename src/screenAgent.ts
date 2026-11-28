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
import { hostname } from 'node:os';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';
import { shareInput } from './handoffAgent.js';

const BIN = process.env.SCREENSHARE_BIN || path.join(process.cwd(), 'hands/bin/screenshare');
/** Each share is its own capture and encoder; more than this at once is a phone that lost track of one. */
const MAX_LIVE = 3;
/** Ways a share ends that are nobody's failure. */
const NORMAL = new Set(['bye', 'stopped', 'disconnected', 'closed']);

/**
 * How long a `failed` end waits for the phone's own report before it is raised. iOS can freeze the
 * phone's page while it stays visible; the frozen viewer stops answering, so the helper sees a dead peer
 * and ends the share `failed`. The page measures that freeze itself and, once it thaws, posts it in
 * `phone_stats.frozen_ms` and counts it (status-hub public/screen.js). A failure the phone has accounted
 * for is counted here too rather than raised a second time; one the phone has not reported by then, or
 * reported with no freeze, is an error.
 */
export const PHONE_REPORT_WAIT_MS = 45_000;
/** The freeze the phone reported for a share, in ms, or 0 when it reported none. */
export function phoneFrozeMs(stats: unknown): number {
  const f = Number((stats as { frozen_ms?: unknown } | null)?.frozen_ms);
  return Number.isFinite(f) && f > 0 ? f : 0;
}

async function reportFailedEnd(id: string, end: string): Promise<void> {
  const { data, error } = await getClient().from('screen_shares').select('phone_stats').eq('id', id).maybeSingle();
  if (error) console.error(`[screen] could not read the phone's report on ${id}: ${error.message}`);
  const f = phoneFrozeMs(data?.phone_stats);
  if (f) console.warn(`[screen] ${id}: share ended: ${end}: the phone's page was frozen ${Math.round(f / 1000)}s`);
  else console.error(`[screen] ${id}: share ended: ${end}`);
}

const live = new Map<string, ChildProcess>();
const liveSource = new Map<string, string>();   // share id -> the device that asked (its user agent)

async function update(id: string, fields: Record<string, unknown>): Promise<void> {
  const { error } = await getClient().from('screen_shares').update({ ...fields, updated_at: new Date().toISOString() }).eq('id', id);
  if (error) console.error(`[screen] ${id}: could not update the row: ${error.message}`);
}

async function share(row: any): Promise<void> {
  const id: string = row.id;
  const t0 = Date.parse(row.created_at) || Date.now();
  // A device asking again (its page reloaded, or the app came back) has left its earlier share behind:
  // that one is ended here as `stopped` rather than left running beside the new one, where its teardown
  // would stop the new capture and its dead connection would end it as `failed`.
  for (const [old, src] of liveSource) {
    if (row.source && src === row.source) { console.log(`[screen] ${old.slice(0, 8)} replaced by ${id.slice(0, 8)} from the same device`); live.get(old)?.stdin?.end(); }
  }
  if (live.size >= MAX_LIVE) {
    console.error(`[screen] ${id}: refused, ${live.size} shares already live`);
    await update(id, { status: 'failed', error: `${live.size} shares already live` });
    return;
  }
  console.log(`[screen] ${id.slice(0, 8)} heard ${Date.now() - t0} ms after it was asked`);
  const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  live.set(id, child);
  if (row.source) liveSource.set(id, row.source);
  let ended = false;
  child.on('error', (e) => console.error(`[screen] ${id}: could not start ${BIN}: ${e.message}`));
  child.stdin!.on('error', () => {});
  child.stdin!.write(JSON.stringify({ offer: row.offer, ice: row.ice || [] }) + '\n');
  createInterface({ input: child.stderr! }).on('line', (l) => console.log(`[screen] ${id.slice(0, 8)} ${l}`));
  createInterface({ input: child.stdout! }).on('line', (l) => {
    let m: any;
    try { m = JSON.parse(l); } catch { return; }
    if (m.answer) {
      console.log(`[screen] ${id.slice(0, 8)} answered ${Date.now() - t0} ms after it was asked`);
      update(id, { status: 'answered', answer: m.answer });
    }
    else if (m.connected) {
      console.log(`[screen] ${id.slice(0, 8)} connected over ${m.path} after ${Date.now() - t0} ms`);
      update(id, { status: 'live', path: m.path, connect_ms: Date.now() - t0 });
    } else if (m.first_frame_ms != null) update(id, { first_frame_ms: m.first_frame_ms });
    else if (m.input) shareInput(row.handoff || null, String(m.input));
    else if (m.end) {
      ended = true;
      const ok = NORMAL.has(m.end);
      if (!ok) setTimeout(() => { reportFailedEnd(id, m.end).catch((e) => console.error(`[screen] ${id}: share ended: ${m.end} (${e.message || e})`)); }, PHONE_REPORT_WAIT_MS);
      update(id, { status: ok ? 'ended' : 'failed', ended_reason: m.end, ...(ok ? {} : { error: m.end }), stats: m.stats || null });
    }
  });
  child.on('exit', (code, sig) => {
    live.delete(id); liveSource.delete(id);
    if (ended) return;
    console.error(`[screen] ${id}: screenshare exited without saying why (code ${code}, signal ${sig})`);
    update(id, { status: 'failed', error: `screenshare exited ${code ?? sig}` });
  });
}

/** Answer every screen share for this machine, for the life of the process. */
export function start(): void {
  // Shares this machine was carrying when it stopped have no helper any more (it died with the agent) and
  // no end written: they are ended here. One that was live had a viewer cut off, which is reported.
  getClient().from('screen_shares').select('id,status').eq('claimed_by', hostname()).in('status', ['new', 'answered', 'live'])
    .then(async ({ data, error }) => {
      if (error) { console.error(`[screen] could not read unfinished shares at start: ${error.message}`); return; }
      for (const r of data || []) {
        if (r.status === 'live') console.error(`[screen] share ${r.id} was live when the screen agent stopped: its viewer was cut off`);
        await update(r.id, { status: 'ended', ended_reason: 'agent restarted' });
      }
    });
  onInserts('screen_shares', share, 0, (row) => row.target === 'mac' && row.status === 'new');
  // A share asked while this agent was restarting was inserted with nobody subscribed, and nothing answers
  // it: the phone waits out its timeout and falls back to screenshots. Any still unclaimed and young enough
  // for the phone to be waiting are claimed and answered now.
  getClient().from('screen_shares').update({ claimed_by: hostname() }).eq('status', 'new').eq('target', 'mac').is('claimed_by', null)
    .gt('created_at', new Date(Date.now() - 20_000).toISOString()).select('*')
    .then(({ data, error }) => {
      if (error) { console.error(`[screen] could not claim shares asked during the restart: ${error.message}`); return; }
      for (const r of data || []) { console.log(`[screen] ${String(r.id).slice(0, 8)} was asked during the restart; answering it`); share(r); }
    });
  console.log('[screen-agent] answering screen shares');
}
