// THE BEDROOM TV's home-network end (google-tv docs/POWER.md), run inside data-http on the Pi.
//
// The TV's own app cannot wake the TV and is not running while it is off, and the hub on Fly cannot
// reach the home network. So the Pi, subscribed to the same tv_commands inserts as the hub, does what
// only a machine beside the TV can, through google-tv's bin/tv:
//   - `power`: the whole command (Wake-on-LAN or adb), answered here; the hub leaves these rows alone.
//   - `open` / `launch`: a Wake-on-LAN packet, harmless when the TV is on. The hub holds the row until
//     the app reconnects and does the rest.
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

async function handle(row: any): Promise<void> {
  if (row.done_at) return;
  if (WAKE_OPS.has(row.op)) {
    await run(TV, ['wake'], { timeout: 10_000 }).catch((e) => console.log('[tv] wake failed', e.message));
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
  const { error } = await getClient().from('tv_commands')
    .update({ done_at: new Date().toISOString(), result }).eq('id', row.id);
  if (error) console.log('[tv] answer failed', error.message);
}

export const start = () => onInserts('tv_commands', handle);
