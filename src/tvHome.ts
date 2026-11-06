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
//   - `appletv`: what the Apple TV app is showing, `bin/tv appletv` (its accessibility tree over adb),
//     answered here; the hub leaves these rows alone. With `play` it presses Play on a title page that
//     sells nothing. bedroomTv.ts sends it after an Apple TV `open`, `now` or `media`, because that app's
//     media session reports its title page's trailer as playing (google-tv docs/WATCHING.md).
//   - an `open` / `launch` of Prime Video: `bin/tv profile prime` once the TV is awake. A cold-started
//     Prime stops on "Who's watching?" before the link, and only a key press (adb) gets past it.
//     The picker shows nothing an event could carry, so this reads the screen for up to 20 s after the
//     open and presses OK only on the words "Who's watching?" (google-tv docs/WATCHING.md).
//
// Started by data-http when HOME_AGENT=1 (the Pi). onInserts claims each row first, so one machine acts on it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';
import { KEYS } from './bedroomTv.js';

const run = promisify(execFile);
const TV = process.env.TV_BIN || `${homedir()}/repos/google-tv/bin/tv`;
const WAKE_OPS = new Set(['open', 'launch', 'input']);
// An open or launch that lands in Prime Video: its package, or a catalog link to watch.amazon.com.
const PRIME = /com\.amazon\.amazonvideo\.livingroom|watch\.amazon\.com|primevideo\.com/;

async function answer(id: string, result: Record<string, unknown>): Promise<void> {
  // Only a row nobody has answered: when the wake worked the app may already have done the command.
  const { error } = await getClient().from('tv_commands')
    .update({ done_at: new Date().toISOString(), result }).eq('id', id).is('done_at', null);
  if (error) console.error('[tv] answer failed', error.message);
}

// Pressing OK is the outcome checked: bin/tv reads the screen again afterwards and exits non-zero if the
// picker is still there, or if every capture was blank so the picker could not have been seen.
async function passProfilePicker(): Promise<void> {
  try {
    const { stdout } = await run(TV, ['profile', 'prime', '20'], { timeout: 90_000 });
    console.log(`[tv] prime: ${stdout.trim()}`);
  } catch (e: any) {
    console.error('[tv] prime profile picker:', String(e.stderr || e.message).trim());
  }
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
    if (row.op !== 'input' && PRIME.test(JSON.stringify(row.args || {}))) await passProfilePicker();
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
  if (row.op === 'appletv') {
    let result: Record<string, unknown>;
    try {
      const { stdout } = await run(TV, ['appletv', row.args?.play ? 'play' : 'check', '15'], { timeout: 40_000 });
      result = { ok: true, ...JSON.parse(stdout.trim().split('\n').pop() || '{}') };
    } catch (e: any) {
      result = { ok: false, error: String(e.stderr || e.message).trim() };
      console.error('[tv] appletv', result.error);
    }
    return answer(row.id, result);
  }
  if (row.op === 'sleep') {
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

export const start = () => onInserts('tv_commands', handle);
