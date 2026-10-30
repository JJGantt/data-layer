// THE BEDROOM TV's home-network end (google-tv docs/POWER.md), run inside data-http on the Pi.
//
// The TV's own app cannot wake the TV and is not running while it is off, and the hub on Fly cannot
// reach the home network. So the Pi, subscribed to the same tv_commands inserts as the hub, does what
// only a machine beside the TV can, through google-tv's bin/tv:
//   - `power`: the whole command (Wake-on-LAN or adb), answered here; the hub leaves these rows alone.
//   - `open` / `launch`: `bin/tv power on` (Wake-on-LAN resent until the TV reports Awake, then adb),
//     harmless when the TV is on. The hub holds the row until the app reconnects and does the rest.
//     If the TV is still off after that, the row is answered here with that, so the caller hears it in
//     seconds instead of waiting out its timeout on a wake that did not happen.
//
// Started by data-http when HOME_AGENT=1 (set only in the Pi's unit), so no machine runs a second copy.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';

const run = promisify(execFile);
const TV = process.env.TV_BIN || `${homedir()}/repos/google-tv/bin/tv`;
const WAKE_OPS = new Set(['open', 'launch']);

async function answer(id: string, result: Record<string, unknown>): Promise<void> {
  // Only a row nobody has answered: when the wake worked the app may already have done the command.
  const { error } = await getClient().from('tv_commands')
    .update({ done_at: new Date().toISOString(), result }).eq('id', id).is('done_at', null);
  if (error) console.log('[tv] answer failed', error.message);
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
    if (now === 'off') await answer(row.id, { ok: false, error: 'the TV is off and did not wake' });
    return;
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
