// THE BEDROOM TV's home-network end (google-tv docs/POWER.md), run inside data-http on the Pi.
//
// The TV's own app cannot wake the TV and is not running while it is off, and the hub on Fly cannot
// reach the home network. So the Pi, subscribed to the same tv_commands inserts as the hub, does what
// only a machine beside the TV can, through google-tv's bin/tv:
//   - `power`: the whole command (Wake-on-LAN or adb), answered here; the hub leaves these rows alone.
//   - `sleep`: a sleep timer, `bin/tv sleep` (a one-shot systemd timer on the Pi), answered here; the
//     hub leaves these rows alone.
//   - `key`: a remote button over adb (an app on the TV cannot inject keys), answered here; the hub
//     leaves these rows alone too. A TV that is off answers that it is off rather than being woken.
//   - `open` / `launch` / `input`: `bin/tv power on` (Wake-on-LAN resent until the TV reports Awake, then adb),
//     harmless when the TV is on. The hub holds the row until the app reconnects and does the rest.
//     If the TV is still off after that, the row is answered here with that, so the caller hears it in
//     seconds instead of waiting out its timeout on a wake that did not happen.
//   - every `open`, whoever wrote it (the bedroom_tv tool, the phone's TV Guide), gets the same
//     follow-up here, and its result is the row's `outcome` + `checked_at` (00176), which is what
//     bedroomTv.ts waits for: Prime's profile picker passed, Apple TV's Play pressed, then whether the
//     app is sending sound. A `launch` of Prime gets the profile step only.
//       Prime: a cold-started Prime stops on "Who's watching?" before the link, and only a key press
//       gets past it. The picker shows nothing an event could carry, so `bin/tv profile prime` reads
//       the screen for up to 20 s and presses OK only on the words "Who's watching?".
//       Apple TV and playing: `bin/tv check`. A link stops on Apple TV's title page, and Play is
//       pressed there when nothing on the page is sold (google-tv docs/WATCHING.md). Playing is the
//       app's sound actually reaching the output, because a media session reports only what its app
//       claims. These are bounded waits for an outcome (each gives up
//       after 15-20 s), not a standing poll: none of these states raises an event the Pi can hear.
//   - `check`: the same Apple TV and playing reads on demand, answered here; the hub leaves these rows
//     alone. bedroomTv.ts sends it after `now` and `media`, whose own answers come from the app's media
//     session. With `play` it presses Play on an Apple TV title page that sells nothing.
//
// Started by data-http when HOME_AGENT=1 (the Pi), and by the Mac's home agent (homeAgent.ts) as the
// fallback: onInserts claims each row first, and the Mac waits before claiming, so it acts only on rows
// the Pi did not take. bin/tv works the same from either machine except `sleep`, whose timer is systemd.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';
import { KEYS, openTarget } from './bedroomTv.js';

const run = promisify(execFile);
const TV = process.env.TV_BIN || `${homedir()}/repos/google-tv/bin/tv`;
const WAKE_OPS = new Set(['open', 'launch', 'input']);
// An open or launch that lands in Prime Video: its package, or a catalog link to watch.amazon.com.
const PRIME = /com\.amazon\.amazonvideo\.livingroom|watch\.amazon\.com|primevideo\.com/;
const APPLE = /com\.apple\.atve\.androidtv\.appletv|tv\.apple\.com/;

async function answer(id: string, result: Record<string, unknown>): Promise<void> {
  // Only a row nobody has answered: when the wake worked the app may already have done the command.
  const { error } = await getClient().from('tv_commands')
    .update({ done_at: new Date().toISOString(), result }).eq('id', id).is('done_at', null);
  if (error) console.error('[tv] answer failed', error.message);
}

// Pressing OK is the outcome checked: bin/tv reads the screen again afterwards and exits non-zero if the
// picker is still there, or if every capture was blank so the picker could not have been seen.
async function passProfilePicker(): Promise<string> {
  try {
    const { stdout } = await run(TV, ['profile', 'prime', '20'], { timeout: 90_000 });
    return stdout.trim();
  } catch (e: any) {
    const err = String(e.stderr || e.message).trim();
    console.error('[tv] prime profile picker:', err);
    return `failed: ${err}`;
  }
}

/** What is really on the TV (`bin/tv check`, one adb connection): Apple TV's title page if `apple`
 *  (pressing Play on it if `play`), then whether the foreground app is sending sound, waiting up to
 *  `wait` seconds for it to start, after `delay` seconds (for a pause, whose last sound is still going
 *  out as it answers). */
export async function inspect(o: { apple: boolean; play: boolean; wait: number; delay?: number }): Promise<Record<string, unknown>> {
  const { stdout } = await run(TV, ['check', o.apple ? '1' : '0', o.play ? '1' : '0', String(o.wait), String(o.delay || 0)], { timeout: 60_000 });
  const c = JSON.parse(stdout.trim().split('\n').pop() || '{}');
  if (c.title_page === false) delete c.title_page;
  return { ...c, playing: !!c.playing };
}

async function check(id: string, outcome: Record<string, unknown>): Promise<void> {
  const { error } = await getClient().from('tv_commands')
    .update({ checked_at: new Date().toISOString(), outcome }).eq('id', id);
  if (error) console.error('[tv] outcome write failed', error.message);
}

/** `bin/tv front`: whether the open's app is in front a few seconds on, and if something else took the
 *  screen (a Cast session does, about a second after being covered), its playback stopped and the link
 *  opened again from here. */
async function bringToFront(target: string, url: string): Promise<Record<string, unknown>> {
  try {
    const { stdout } = await run(TV, ['front', target, url], { timeout: 40_000 });
    const f = JSON.parse(stdout.trim().split('\n').pop() || '{}');
    if (!f.front) console.error(`[tv] open: ${f.foreground} is in front instead of ${target}`, JSON.stringify(f));
    return f;
  } catch (e: any) {
    const err = String(e.stderr || e.message).trim();
    console.error('[tv] open: bringing it to the front failed', err);
    return { target, front_error: err };
  }
}

async function followUp(row: any): Promise<void> {
  const args = JSON.stringify(row.args || {});
  const outcome: Record<string, unknown> = {};
  const target = row.op === 'open' ? openTarget(row.args || {}) : null;
  if (target) {
    const f = await bringToFront(target, String(row.args.url));
    outcome.target = target;
    if (f.reopened) outcome.reopened = true;
    if (f.displaced_by) outcome.displaced_by = f.displaced_by;
  }
  if (PRIME.test(args)) outcome.profile = await passProfilePicker();
  if (row.op !== 'open') return;
  try {
    Object.assign(outcome, await inspect({ apple: APPLE.test(args), play: true, wait: 15 }));
  } catch (e: any) {
    outcome.error = String(e.stderr || e.message).trim();
    console.error('[tv] open follow-up', outcome.error);
  }
  if (!outcome.playing) console.error(`[tv] open: nothing playing afterwards ${JSON.stringify(outcome)} for ${args}`);
  await check(row.id, outcome);
}

async function handle(row: any): Promise<void> {
  if (row.done_at) return;
  if (WAKE_OPS.has(row.op)) {
    let now: string | undefined;
    try {
      const { stdout } = await run(TV, ['power', 'on'], { timeout: 30_000 });
      now = stdout.trim().split('\n').pop();
    } catch (e: any) {
      // adb unreachable says nothing about the screen: the packets may still have woken it.
      console.log('[tv] wake check failed', String(e.stderr || e.message).trim());
      return;
    }
    console.log(`[tv] ${row.op}: TV ${now}`);
    if (now === 'off') return answer(row.id, { ok: false, error: 'the TV is off and did not wake' });
    if (row.op !== 'input') await followUp(row);
    return;
  }
  if (row.op === 'key') {
    const code = KEYS[String(row.args?.key || '')];
    if (!code) return answer(row.id, { ok: false, error: `unknown key ${row.args?.key}` });
    let result: Record<string, unknown>;
    try {
      const { stdout } = await run(TV, ['power'], { timeout: 20_000 });
      if (stdout.trim() !== 'on') return answer(row.id, { ok: false, error: 'the TV is off' });
      await run(TV, ['key', code], { timeout: 20_000 });
      result = { ok: true, key: row.args.key };
    } catch (e: any) {
      result = { ok: false, error: String(e.stderr || e.message).trim() };
    }
    return answer(row.id, result);
  }
  if (row.op === 'check') {
    let result: Record<string, unknown>;
    try {
      result = { ok: true, ...await inspect({ apple: !!row.args?.apple, play: !!row.args?.play, wait: Number(row.args?.wait) || 0, delay: Number(row.args?.delay) || 0 }) };
    } catch (e: any) {
      result = { ok: false, error: String(e.stderr || e.message).trim() };
      console.error('[tv] check', result.error);
    }
    return answer(row.id, result);
  }
  if (row.op === 'sleep') {
    if (process.platform !== 'linux') return answer(row.id, { ok: false, error: 'the sleep timer runs only on the Pi, which is not answering' });
    // bin/tv sleep holds the timer in the Pi's systemd, so it outlives this process; it prints when it
    // fires, or `none`. Setting one on a TV that is off is refused, like any op but a wake.
    const m = row.args?.minutes;
    let result: Record<string, unknown>;
    try {
      if (m !== undefined && Number(m) > 0) {
        const { stdout } = await run(TV, ['power'], { timeout: 20_000 });
        if (stdout.trim() !== 'on') return answer(row.id, { ok: false, error: 'the TV is off' });
      }
      const arg = m === undefined ? [] : Number(m) > 0 ? [String(Number(m))] : ['off'];
      const { stdout } = await run(TV, ['sleep', ...arg], { timeout: 20_000 });
      const at = stdout.trim().split('\n').pop();
      result = { ok: true, at: at === 'none' ? null : at };
    } catch (e: any) {
      result = { ok: false, error: String(e.stderr || e.message).trim() };
      console.error('[tv] sleep', result.error);
    }
    return answer(row.id, result);
  }
  if (row.op !== 'power') return;
  const state = row.args?.on === false ? 'off' : 'on';
  let result: Record<string, unknown>;
  try {
    const { stdout } = await run(TV, ['power', state], { timeout: 30_000 });
    const now = stdout.trim().split('\n').pop();
    result = { ok: now === state, power: now };
  } catch (e: any) {
    result = { ok: false, error: String(e.stderr || e.message).trim() };
  }
  await answer(row.id, result);
}

export const start = (deferMs = 0) => onInserts('tv_commands', handle, deferMs);
