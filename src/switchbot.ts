import { createHmac, randomUUID } from 'node:crypto';
import { getClient } from './client.js';
import { startRace } from './lobby.js';

// The front door: a SwitchBot Lock Ultra with a Keypad Touch, on the cloud through a Hub Mini
// (`front_door`). SwitchBot's Open API v1.1 answers the lock's current state and takes lock/unlock;
// it has no history endpoint, so the history is our own table `door_events`, written through
// door_report() by the Bluetooth listener (door/listener.py) and the status hub, whose slow backstop
// fills in and reports any change no source recorded.
//
// Credentials: SWITCHBOT_TOKEN and SWITCHBOT_SECRET (the app's Profile → Preferences → About → tap App
// Version ten times → Developer Options), in each machine's data-layer/.env and as Fly secrets on
// jared-voice-worker and jared-status-hub. README § The front door.

const API = 'https://api.switch-bot.com/v1.1';
export const OPS = ['status', 'lock', 'unlock', 'history', 'lobby'] as const;
export type Op = typeof OPS[number];
// Device types the API reports for a lock (Lock, Lock Pro, Lock Ultra, Lock Lite).
const LOCK_TYPE = /lock/i;
const CONFIRM_MS = 15_000;

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

/** Lock or unlock, answered once the lock's own state shows it: the command, then status reads until
 *  the new state appears or CONFIRM_MS passes. No read goes before the command: one sent to a lock
 *  already in that state does nothing, and a read first adds its round trip to every command. A
 *  command SwitchBot accepted that never takes effect is an error. */
async function command(want: 'locked' | 'unlocked'): Promise<string> {
  const id = await findLock();
  await call('POST', `/devices/${id}/commands`, { command: want === 'locked' ? 'lock' : 'unlock', parameter: 'default', commandType: 'command' });
  const sent = Date.now();
  let s: DoorState | null = null;
  while (Date.now() - sent < CONFIRM_MS) {
    await new Promise((r) => setTimeout(r, 1500));
    s = await readState();
    if (s.lock === want) return `Door ${want} (${describe(s)}), ${((Date.now() - sent) / 1000).toFixed(1)}s.`;
  }
  throw new Error(`Sent ${want === 'locked' ? 'lock' : 'unlock'}, but after ${CONFIRM_MS / 1000}s the lock reports ${s ? describe(s) : 'nothing'}`);
}

async function history(limit: number): Promise<string> {
  const db = getClient();
  const { data, error } = await db.from('door_events')
    .select('id, at, event, lock_state, door_state, source').order('at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  if (!data?.length) return 'No door events recorded yet.';
  // Which sources reported each change and how many seconds after it was recorded (door_sightings, 00211).
  const { data: heard, error: e2 } = await db.from('door_event_sources').select('id, heard_by').in('id', data.map((r: any) => r.id));
  if (e2) throw new Error(e2.message);
  const by = new Map((heard || []).map((h: any) => [h.id, h.heard_by]));
  return data.map((r: any) => {
    const h = by.get(r.id);
    const sources = h ? `  heard by ${Object.entries(h).map(([s, d]) => `${s} +${d}s`).join(', ') || 'none'}` : '';
    return `${r.at}  ${r.event}  (lock ${r.lock_state ?? '?'}, door ${r.door_state ?? '?'})  recorded by ${r.source}${r.source === 'backstop' ? ' [missed by every source]' : ''}${sources}`;
  }).join('\n');
}

export async function run(op: Op, a: Record<string, any> = {}): Promise<string> {
  if (op === 'status') return `Front door: ${describe(await readState())}.`;
  if (op === 'lock') return command('locked');
  if (op === 'unlock') return command('unlocked');
  if (op === 'lobby') {
    const door = a.door ?? 'main';
    if (!['main', 'north', 'south'].includes(door)) throw new Error(`lobby door must be main, north or south, not ${door}`);
    return startRace('voice', door);
  }
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
