import { createHmac, randomUUID } from 'node:crypto';
import { getClient } from './client.js';

// The front door: a SwitchBot Lock Ultra with a Keypad Touch, on the cloud through a Hub Mini
// (`front_door`). SwitchBot's Open API v1.1 answers the lock's current state and takes lock/unlock;
// it has no history endpoint, so the history is our own table `door_events` (migration 00206), written
// by the status hub from SwitchBot's webhook (status-hub server/routes/switchbot.js), with a slow
// backstop there that fills in and reports any event the webhook missed.
//
// Credentials: SWITCHBOT_TOKEN and SWITCHBOT_SECRET (the app's Profile → Preferences → About → tap App
// Version ten times → Developer Options), in each machine's data-layer/.env and as Fly secrets on
// jared-voice-worker and jared-status-hub. README § The front door.

const API = 'https://api.switch-bot.com/v1.1';
export const OPS = ['status', 'lock', 'unlock', 'history'] as const;
export type Op = typeof OPS[number];
// Device types the API reports for a lock (Lock, Lock Pro, Lock Ultra, Lock Lite).
const LOCK_TYPE = /lock/i;
const CONFIRM_MS = 20_000;

function config(): { token: string; secret: string } {
  const missing = ['SWITCHBOT_TOKEN', 'SWITCHBOT_SECRET'].filter((k) => !process.env[k]);
  if (missing.length) {
    const msg = `The front door is not configured on this machine: ${missing.join(', ')} not set`;
    console.error(`[switchbot] ${msg}`);
    throw new Error(msg);
  }
  return { token: process.env.SWITCHBOT_TOKEN!, secret: process.env.SWITCHBOT_SECRET! };
}

/** One signed API call: sign = base64(HMAC-SHA256(secret, token + t + nonce)). SwitchBot wraps every
 *  answer in {statusCode, message, body}; anything but statusCode 100 is a failure even on HTTP 200. */
export async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const { token, secret } = config();
  const t = String(Date.now());
  const nonce = randomUUID();
  const sign = createHmac('sha256', secret).update(token + t + nonce).digest('base64');
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: token, sign, t, nonce, 'Content-Type': 'application/json; charset=utf8' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error(`SwitchBot ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok || j.statusCode !== 100) {
    throw new Error(`SwitchBot ${method} ${path}: HTTP ${res.status}, statusCode ${j.statusCode} ${j.message || ''}`.trim());
  }
  return j.body;
}

let lockId: string | null = null;

/** The lock's device id: SWITCHBOT_LOCK_ID when set, else the one lock on the account. */
export async function findLock(): Promise<string> {
  if (lockId) return lockId;
  if (process.env.SWITCHBOT_LOCK_ID) return (lockId = process.env.SWITCHBOT_LOCK_ID);
  const b = await call('GET', '/devices');
  const locks = (b.deviceList || []).filter((d: any) => LOCK_TYPE.test(String(d.deviceType)));
  if (locks.length !== 1) {
    throw new Error(`Expected one lock on the SwitchBot account, found ${locks.length}`
      + (locks.length ? `: ${locks.map((d: any) => `${d.deviceName} (${d.deviceId})`).join(', ')}; set SWITCHBOT_LOCK_ID` : ''));
  }
  return (lockId = locks[0].deviceId);
}

export interface DoorState { lock: string; door: string | null; battery: number | null; raw: any }

export async function readState(): Promise<DoorState> {
  const b = await call('GET', `/devices/${await findLock()}/status`);
  return {
    lock: String(b.lockState || 'unknown').toLowerCase(),
    door: b.doorState ? String(b.doorState).toLowerCase() : null,
    battery: typeof b.battery === 'number' ? b.battery : null,
    raw: b,
  };
}

const describe = (s: DoorState) =>
  `${s.lock}${s.door ? `, door ${s.door}` : ''}${s.battery !== null ? `, battery ${s.battery}%` : ''}`;

/** Lock or unlock, answered once the lock's own state shows it. The webhook's door_events row is the
 *  confirmation; when none arrives in CONFIRM_MS, one status read decides, and a command that took
 *  effect without its event is still reported, because it means the webhook path is down. */
async function command(want: 'locked' | 'unlocked'): Promise<string> {
  const id = await findLock();
  const before = await readState();
  if (before.lock === want) return `Already ${want} (${describe(before)}).`;
  const sb = getClient();
  const sent = Date.now();
  const heard = new Promise<boolean>((resolve) => {
    const ch = sb.channel(`door-${randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'door_events' }, (p: any) => {
        if (p.new?.lock_state === want) { sb.removeChannel(ch); resolve(true); }
      })
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        try {
          await call('POST', `/devices/${id}/commands`, { command: want === 'locked' ? 'lock' : 'unlock', parameter: 'default', commandType: 'command' });
        } catch (e) { sb.removeChannel(ch); resolve(false); console.error(`[switchbot] ${want} command failed:`, e); }
      });
    setTimeout(() => { sb.removeChannel(ch); resolve(false); }, CONFIRM_MS);
  });
  const viaEvent = await heard;
  const s = await readState();
  if (s.lock !== want) throw new Error(`Sent ${want === 'locked' ? 'lock' : 'unlock'}, but the lock reports ${describe(s)}`);
  if (!viaEvent) console.error(`[switchbot] ${want} took effect but no door_events row arrived within ${CONFIRM_MS / 1000}s; the webhook path may be down`);
  return `Door ${want} (${describe(s)}), ${((Date.now() - sent) / 1000).toFixed(1)}s.`;
}

async function history(limit: number): Promise<string> {
  const { data, error } = await getClient().from('door_events')
    .select('at, event, lock_state, door_state, source').order('at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  if (!data?.length) return 'No door events recorded yet.';
  return data.map((r: any) => `${r.at}  ${r.event}  (lock ${r.lock_state ?? '?'}, door ${r.door_state ?? '?'})${r.source === 'backstop' ? '  [missed by webhook]' : ''}`).join('\n');
}

export async function run(op: Op, a: Record<string, any> = {}): Promise<string> {
  if (op === 'status') return `Front door: ${describe(await readState())}.`;
  if (op === 'lock') return command('locked');
  if (op === 'unlock') return command('unlocked');
  return history(Math.min(Math.max(Number(a.limit) || 20, 1), 200));
}

/** Point SwitchBot's webhook (one per account) at `url`, replacing any other. Run once per URL, by
 *  bin/switchbot-webhook. Answers the URL SwitchBot then reports. */
export async function setWebhook(url: string): Promise<string> {
  const have: string[] = (await call('POST', '/webhook/queryWebhook', { action: 'queryUrl' }).catch(() => ({ urls: [] }))).urls || [];
  for (const u of have) if (u !== url) await call('POST', '/webhook/deleteWebhook', { action: 'deleteWebhook', url: u });
  if (!have.includes(url)) await call('POST', '/webhook/setupWebhook', { action: 'setupWebhook', url, deviceList: 'ALL' });
  const now: string[] = (await call('POST', '/webhook/queryWebhook', { action: 'queryUrl' })).urls || [];
  if (!now.includes(url)) throw new Error(`SwitchBot reports webhook ${JSON.stringify(now)}, not the one set`);
  return `SwitchBot webhook is set (${now.length} URL).`;
}
