/**
 * JaredBot's on/off switch, enforced on the Mac (README § JaredBot switch).
 *
 * `app_settings.jaredbot_enabled` is the switch. Off means the jaredbot launchd job is not running at
 * all, so nothing reads chat.db; jaredbot.py also exits by itself whenever it finds the switch off.
 * This watches the row over realtime and starts the job when it turns on, stops it when it turns off.
 * A slow backstop re-applies the switch in case the channel went deaf.
 *
 * Mac only: chat.db and the job exist nowhere else.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { getClient } from './client.js';

const run = promisify(execFile);
const KEY = 'jaredbot_enabled';
const LABEL = 'com.jaredgantt.jaredbot';
const PLIST = `${homedir()}/Library/LaunchAgents/${LABEL}.plist`;
const BACKSTOP_MS = 10 * 60e3;

const target = () => `gui/${process.getuid?.()}/${LABEL}`;

/** The job's pid, or null when it is loaded but not running; undefined when it is not loaded. */
async function jobPid(): Promise<number | null | undefined> {
  try {
    const { stdout } = await run('launchctl', ['print', target()]);
    const m = stdout.match(/^\s*pid = (\d+)/m);
    return m ? Number(m[1]) : null;
  } catch { return undefined; }
}

export function isOn(value: string | null | undefined): boolean {
  return ['1', 'true', 'on', 'yes'].includes(String(value ?? '').trim().toLowerCase());
}

async function readSwitch(): Promise<boolean> {
  const { data, error } = await getClient().from('app_settings').select('value').eq('key', KEY).maybeSingle();
  if (error) throw new Error(error.message);
  return isOn(data?.value);
}

async function apply(on: boolean, why: string): Promise<void> {
  const pid = await jobPid();
  if (on && !pid) {
    if (pid === undefined) await run('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, PLIST]);
    else await run('launchctl', ['kickstart', target()]);
    await new Promise((r) => setTimeout(r, 5000));
    if (!(await jobPid())) console.error(`[jaredbot-switch] switch is on (${why}) but the job did not start`);
    else console.log(`[jaredbot-switch] on (${why}): started jaredbot`);
  } else if (!on && pid) {
    // SIGTERM; launchd restarts that unsuccessful exit once, and the restart finds the switch off and
    // exits cleanly before opening chat.db.
    await run('launchctl', ['kill', 'SIGTERM', target()]);
    console.log(`[jaredbot-switch] off (${why}): stopped jaredbot`);
  }
}

export function start(): void {
  if (process.platform !== 'darwin') return;
  const check = (why: string) => readSwitch().then((on) => apply(on, why))
    .catch((e) => console.error('[jaredbot-switch] could not apply the switch:', e.message));

  let backoff = 1000;
  const connect = () => {
    const sb = getClient();
    let replaced = false;
    const ch = sb.channel('jaredbot-switch')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'app_settings', filter: `key=eq.${KEY}` },
        (p: any) => { console.log(`[jaredbot-switch] switch is now ${isOn(p.new?.value) ? 'on' : 'off'}`); apply(isOn(p.new?.value), 'changed').catch((e) => console.error('[jaredbot-switch] apply failed:', e.message)); })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') { backoff = 1000; console.log('[jaredbot-switch] subscribed'); check('subscribed'); return; }
        if (!replaced && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) {
          replaced = true;
          sb.removeChannel(ch);
          setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 60_000);
        }
      });
  };
  connect();
  setInterval(() => check('backstop'), BACKSTOP_MS);
}
