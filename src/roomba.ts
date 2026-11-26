/**
 * The Roomba (i7+), controlled over its LOCAL MQTT interface — no iRobot cloud in the path.
 *
 * Only a machine on the home network can reach it, so the `roomba` tool goes through home_requests
 * (homeRequests.ts): data-http on the Pi answers, the Mac's home agent is the fallback. Each request
 * opens a connection, reads the state the robot pushes on connect, acts, watches the state for the
 * effect, and closes; nothing stays connected between requests.
 *
 * Needs ROOMBA_IP, ROOMBA_BLID and ROOMBA_PASSWORD in data-layer/.env (roomba/fetch-cloud.py writes the
 * last two). The IP is DHCP: when it stops answering, the robot is found again by its UDP discovery
 * broadcast and the new address is used for this process's life. Room and zone names come from
 * roomba_rooms, which the same script fills from the home map in the iRobot app (app_settings.roomba_map;
 * the app keeps other maps, which are never saved or offered). `rooms` reads that saved list;
 * `update_rooms` re-runs the script with the iRobot login stored in .env.
 */
import dgram from 'node:dgram';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import mqtt from 'mqtt';
import { getClient } from './client.js';
import { ValidationError } from './helpers.js';

export const OPS = ['status', 'rooms', 'update_rooms', 'start', 'clean_rooms', 'pause', 'resume', 'stop', 'dock', 'empty_bin', 'settings', 'set'] as const;
export type Op = typeof OPS[number];

type Reported = Record<string, any>;
type Mission = { cycle?: string; phase?: string; error?: number; notReady?: number; mssnM?: number; sqft?: number };

const PHASES: Record<string, string> = {
  charge: 'docked, charging', run: 'cleaning', stop: 'stopped', stuck: 'stuck', pause: 'paused',
  hmUsrDock: 'going home', hmMidMsn: 'going home to recharge mid-clean', hmPostMsn: 'going home after cleaning',
  evac: 'emptying its bin', chargingerror: 'charging error', recharge: 'recharging mid-clean',
};

let ip = process.env.ROOMBA_IP || '';

function creds() {
  getClient();  // loads data-layer/.env into process.env
  ip ||= process.env.ROOMBA_IP || '';
  const blid = process.env.ROOMBA_BLID, password = process.env.ROOMBA_PASSWORD;
  if (!ip || !blid || !password) throw new Error('ROOMBA_IP / ROOMBA_BLID / ROOMBA_PASSWORD missing from data-layer/.env on this machine (roomba/fetch-cloud.py)');
  return { blid, password };
}

/** The robot's address by its discovery broadcast, or null when nothing with this blid answers in 3s. */
function discover(blid: string): Promise<string | null> {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const done = (v: string | null) => { clearTimeout(t); s.close(); resolve(v); };
    const t = setTimeout(() => done(null), 3000);
    s.on('message', (buf) => {
      try { const m = JSON.parse(buf.toString()); if (m.robotid === blid || String(m.hostname).endsWith(blid)) done(m.ip); } catch { /* our own echo */ }
    });
    s.bind(() => { s.setBroadcast(true); s.send('irobotmcs', 5678, '255.255.255.255'); });
  });
}

type Conn = { client: mqtt.MqttClient; state: Reported; changed: () => Promise<void> };

async function open(extra: string[] = []): Promise<Conn> {
  const { blid, password } = creds();
  // ciphers / secureOptions pass through to tls.connect; mqtt's option type does not list them.
  const connectTo = (host: string) => mqtt.connectAsync(`mqtts://${host}:8883`, {
    clientId: blid, username: blid, password, protocolVersion: 4, reconnectPeriod: 0, connectTimeout: 8000,
    // Self-signed certificate, small DH parameters, legacy renegotiation: what roombapy's TLS setup allows.
    rejectUnauthorized: false, ciphers: 'DEFAULT:!DH', secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
  } as mqtt.IClientOptions);
  let client: mqtt.MqttClient;
  try {
    client = await connectTo(ip);
  } catch (e: any) {
    const found = await discover(blid);
    if (!found || found === ip) throw new Error(`cannot reach the Roomba at ${ip}: ${e.message}${found ? '' : ' (and it did not answer discovery)'}`);
    console.error(`[roomba] ${ip} did not answer; discovery found it at ${found}. Update ROOMBA_IP in data-layer/.env.`);
    ip = found;
    client = await connectTo(ip);
  }
  const state: Reported = {};
  let wake: (() => void) | null = null;
  client.on('message', (_t, buf) => {
    try { Object.assign(state, JSON.parse(buf.toString()).state?.reported || {}); } catch { return; }
    wake?.();
  });
  const changed = () => new Promise<void>((r) => { wake = () => { wake = null; r(); }; });
  // The robot publishes its whole state in pieces right after connect; status needs these keys.
  const need = ['cleanMissionStatus', 'batPct', 'bin', 'pmaps', ...extra];
  const deadline = Date.now() + 8000;
  while (!need.every((k) => k in state) && Date.now() < deadline) {
    await Promise.race([changed(), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
  }
  if (!('cleanMissionStatus' in state)) { await client.endAsync(); throw new Error('connected, but the Roomba sent no state in 8s'); }
  return { client, state, changed };
}

function describe(s: Reported): string {
  const m: Mission = s.cleanMissionStatus || {};
  const phase = PHASES[m.phase || ''] || m.phase || 'unknown';
  const parts = [`${s.name || 'Roomba'}: ${phase}`, `battery ${s.batPct}%`];
  if (s.bin?.full) parts.push('bin FULL');
  if (m.cycle && m.cycle !== 'none' && m.phase !== 'charge') parts.push(`mission ${m.cycle}, ${m.mssnM ?? 0} min in`);
  if (m.error) parts.push(`error code ${m.error}`);
  if (m.notReady) parts.push(`not ready (code ${m.notReady})`);
  return parts.join(' · ');
}

type Area = { pmap_id: string; kind: 'room' | 'zone'; region_id: string; name: string; user_pmapv_id: string };

/** The id an area is passed by: r<id> for a room, z<id> for a Clean Zone (the two are numbered apart). */
const areaId = (a: Area) => `${a.kind === 'zone' ? 'z' : 'r'}${a.region_id}`;

/** The rooms and zones on the home map. fetch-cloud.py saves no other map, so this is the whole table. */
async function areas(): Promise<Area[]> {
  const { data, error } = await getClient().from('roomba_rooms').select('*');
  if (error) throw new Error(`roomba_rooms: ${error.message}`);
  return ((data || []) as Area[]).sort((x, y) => x.kind.localeCompare(y.kind) || Number(x.region_id) - Number(y.region_id));
}

/** Cleaning preferences as the robot reports them: how each one reads, and the state that sets each value. */
const PREFS: Record<string, { read: (s: Reported) => string | null; values: Record<string, Reported> }> = {
  passes: {
    read: (s) => !('noAutoPasses' in s) ? null : !s.noAutoPasses ? 'auto' : s.twoPass ? '2' : '1',
    values: { auto: { noAutoPasses: false, twoPass: false }, '1': { noAutoPasses: true, twoPass: false }, '2': { noAutoPasses: true, twoPass: true } },
  },
  edge_clean: {
    read: (s) => !('openOnly' in s) ? null : s.openOnly ? 'off' : 'on',
    values: { on: { openOnly: false }, off: { openOnly: true } },
  },
  power: {
    read: (s) => !('carpetBoost' in s) ? null : s.carpetBoost ? 'auto' : s.vacHigh ? 'performance' : 'eco',
    values: { auto: { carpetBoost: true, vacHigh: false }, performance: { carpetBoost: false, vacHigh: true }, eco: { carpetBoost: false, vacHigh: false } },
  },
  bin_full_pause: {
    read: (s) => !('binPause' in s) ? null : s.binPause ? 'on' : 'off',
    values: { on: { binPause: true }, off: { binPause: false } },
  },
};
export const PREF_NAMES = Object.keys(PREFS);

function describePrefs(s: Reported): string {
  const shown = Object.entries(PREFS).map(([k, p]) => [k, p.read(s)] as const).filter(([, v]) => v !== null);
  return shown.length ? shown.map(([k, v]) => `${k}: ${v}`).join(' · ') : 'the robot reports none of the known preferences';
}

/** The per-clean overrides a start command carries, from the `passes` / `edge_clean` arguments. */
function cleanParams(args: Record<string, any>): Reported | null {
  const p: Reported = {};
  for (const k of ['passes', 'edge_clean'] as const) {
    if (args[k] === undefined) continue;
    const v = PREFS[k].values[String(args[k])];
    if (!v) throw new ValidationError(`${k} must be one of ${Object.keys(PREFS[k].values).join(', ')}`);
    Object.assign(p, v);
  }
  return Object.keys(p).length ? p : null;
}

/** What the robot's state must show for a command to have taken effect. */
const EFFECT: Record<string, (m: Mission) => boolean> = {
  start: (m) => m.phase === 'run',
  resume: (m) => m.phase === 'run',
  pause: (m) => m.phase === 'stop' || m.phase === 'pause',
  stop: (m) => m.phase !== 'run',
  dock: (m) => m.phase === 'hmUsrDock' || m.phase === 'charge',
  evac: (m) => m.phase === 'evac',
};
const EFFECT_MS = 25_000;

async function command(c: Conn, cmd: string, params: Record<string, unknown> = {}, effect = EFFECT[cmd]): Promise<string> {
  const m0: Mission = c.state.cleanMissionStatus || {};
  if (effect(m0)) return `Already so — ${describe(c.state)}`;
  const idle = !m0.cycle || m0.cycle === 'none';
  if ((cmd === 'pause' || cmd === 'resume') && idle) return `Nothing to ${cmd}: no clean in progress — ${describe(c.state)}`;
  const time = Math.floor(Date.now() / 1000);
  await c.client.publishAsync('cmd', JSON.stringify({ command: cmd, time, initiator: 'localApp', ...params }));
  const deadline = Date.now() + EFFECT_MS;
  while (Date.now() < deadline) {
    const m: Mission = c.state.cleanMissionStatus || {};
    if (m.error) break;
    if (effect(m)) return describe(c.state);
    await Promise.race([c.changed(), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
  }
  const heard = c.state.lastCommand?.time === time;
  throw new Error(`${cmd} did not take effect in ${EFFECT_MS / 1000}s (${heard ? 'the robot acknowledged it' : 'the robot never acknowledged it'}) — ${describe(c.state)}`);
}

const FETCH = fileURLToPath(new URL('../roomba/fetch-cloud.py', import.meta.url));

/** Re-copy the rooms from the iRobot cloud map into roomba_rooms. Null on success, else why not. */
function refreshRooms(): Promise<string | null> {
  // The script reads .env itself, so a login saved after this process started is still used.
  return new Promise((resolve) => execFile('python3', [FETCH], { timeout: 45_000 }, (err, _out, stderr) => {
    if (!err) return resolve(null);
    const why = (stderr || err.message).trim().split('\n').pop() || 'failed';
    console.error(`[roomba] room refresh from the iRobot cloud failed: ${why}`);
    resolve(why);
  }));
}

function listAreas(as: Area[]): string {
  if (!as.length) return 'No named rooms or zones on the home map.';
  return as.map((a) => `${a.name} — ${a.kind} ${areaId(a)}`).join('\n');
}

/** Set saved preferences by publishing to `delta`, then wait for the robot's reported state to show them. */
async function setPrefs(c: Conn, args: Record<string, any>): Promise<string> {
  const want: Reported = {};
  for (const k of PREF_NAMES) {
    if (args[k] === undefined) continue;
    if (PREFS[k].read(c.state) === null) throw new ValidationError(`this robot does not report ${k}, so it cannot be set`);
    const v = PREFS[k].values[String(args[k])];
    if (!v) throw new ValidationError(`${k} must be one of ${Object.keys(PREFS[k].values).join(', ')}`);
    Object.assign(want, v);
  }
  if (!Object.keys(want).length) throw new ValidationError(`set needs at least one of ${PREF_NAMES.join(', ')}`);
  await c.client.publishAsync('delta', JSON.stringify({ state: want }));
  const deadline = Date.now() + EFFECT_MS;
  while (Date.now() < deadline) {
    if (Object.entries(want).every(([k, v]) => c.state[k] === v)) return `Saved — ${describePrefs(c.state)}`;
    await Promise.race([c.changed(), new Promise((r) => setTimeout(r, deadline - Date.now()))]);
  }
  throw new Error(`preferences did not change in ${EFFECT_MS / 1000}s — ${describePrefs(c.state)}`);
}

export async function roomba(op: Op, args: Record<string, any> = {}): Promise<string> {
  if (op === 'rooms') return listAreas(await areas());
  if (op === 'update_rooms') {
    const failed = await refreshRooms();
    if (failed) throw new Error(`could not update the rooms from the iRobot app: ${failed}`);
    return `Updated from the iRobot app:\n${listAreas(await areas())}`;
  }
  const params = op === 'start' || op === 'clean_rooms' ? cleanParams(args) : null;
  let start: Reported = params ? { params } : {};
  let chosen: Area[] = [];
  if (op === 'clean_rooms') {
    const want: string[] = (args.areas || []).map(String);
    if (!want.length) throw new ValidationError('clean_rooms needs `areas`: ids from the rooms op');
    const all = await areas();
    const unknown = want.filter((w) => !all.some((a) => areaId(a) === w));
    if (unknown.length) throw new ValidationError(`no room or zone ${unknown.join(', ')} on the home map; the ids are:\n${listAreas(all)}`);
    chosen = want.map((w) => all.find((a) => areaId(a) === w)!);
    // The app's room-specific settings ride on each region; the same overrides go on every one.
    start = { ordered: 1, pmap_id: chosen[0].pmap_id, user_pmapv_id: chosen[0].user_pmapv_id,
      regions: chosen.map((a) => ({ region_id: a.region_id, type: a.kind === 'zone' ? 'zid' : 'rid', ...(params ? { params } : {}) })) };
  }
  const c = await open(op === 'settings' || op === 'set' ? ['noAutoPasses', 'openOnly', 'carpetBoost', 'binPause'] : []);
  try {
    switch (op) {
      case 'status': return describe(c.state);
      case 'start': return await command(c, 'start', start);
      case 'clean_rooms': return `${chosen.map((a) => a.name).join(', ')}: ${await command(c, 'start', start)}`;
      case 'settings': return describePrefs(c.state);
      case 'set': return await setPrefs(c, args);
      case 'pause': return await command(c, 'pause');
      case 'resume': return await command(c, 'resume');
      case 'stop': return await command(c, 'stop');
      case 'dock': {
        // The robot acknowledges `dock` during a running or paused clean and ignores it, so the clean
        // is ended first; from `stop` the dock takes.
        const phase = c.state.cleanMissionStatus?.phase;
        if (phase === 'run' || phase === 'pause') await command(c, 'stop', {}, (m) => m.phase === 'stop');
        return await command(c, 'dock');
      }
      case 'empty_bin': return await command(c, 'evac');
      default: throw new Error(`unknown op ${op}`);
    }
  } finally {
    await c.client.endAsync().catch(() => {});
  }
}
