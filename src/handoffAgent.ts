/**
 * The handoff agent: carries out Jared's taps on the screen a session handed him (handoff.ts).
 *
 * One runs on each machine that owns a screen, and answers only the targets that machine has
 * (HANDOFF_TARGETS): the Mac `mac-screen` and `mac-chrome`, the Pi `pi-browser`. A screen exists on one
 * machine only, so unlike every other agent here there is no fallback: a handoff for a machine that is
 * down stays unclaimed, and the missed-row sweep reports it.
 *
 * For each new handoff it screenshots the target and stores it (shared-images), which is what the hub
 * pushes to the phone. For each action he sends it clicks or types on the real screen, clears any typed
 * text from the row, and screenshots again.
 *
 * On the Mac it is its own process (handoffMain.ts) under hands-launch (hands/), which holds Screen
 * Recording and Accessibility. On the Pi it runs inside data-http (http.ts), which needs no grant.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { getClient } from './client.js';
import { onInserts } from './realtime.js';
import { uuid } from './helpers.js';
import { BUCKET } from './images.js';

const run = promisify(execFile);

const HANDS = process.env.HANDS_BIN || path.join(process.cwd(), 'hands/bin/hands');
const CDP = process.env.HANDOFF_CDP || 'http://127.0.0.1:9223';
/**
 * A click starts something the screen shows a moment later (a page loading, a menu opening), and no
 * event says "the screen has finished changing". So the screenshot after an action waits this long;
 * a result still in motion is what the Refresh button is for.
 */
const SETTLE_MS = Number(process.env.HANDOFF_SETTLE_MS || 1200);

type Frame = { png: Buffer; width: number; height: number };
interface Screen {
  shot(): Promise<Frame>;
  tap(fx: number, fy: number): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
}

// ---- the Mac ---------------------------------------------------------------------------------------

async function hands(args: string[], input?: string): Promise<string> {
  const p = run(HANDS, args, { timeout: 15_000 });
  if (input != null) { p.child.stdin?.end(input); }
  const { stdout } = await p;
  return stdout;
}

type Box = { id?: number; x: number; y: number; w: number; h: number };

async function capture(args: string[]): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handoff-'));
  const file = path.join(dir, 'shot.png');
  try {
    await run('/usr/sbin/screencapture', ['-x', '-t', 'png', ...args, file], { timeout: 15_000 });
    return await readFile(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The whole main display. A tap is a fraction of the screenshot, so it maps onto the display's points
 *  whatever the pixel density. */
function macScreen(): Screen {
  let box: Box | null = null;
  return {
    async shot() {
      box = JSON.parse(await hands(['screen']));
      const png = await capture(['-D', '1']);
      return { png, ...pngSize(png) };
    },
    async tap(fx, fy) {
      const b = box || JSON.parse(await hands(['screen']));
      await hands(['click', String(b.x + fx * b.w), String(b.y + fy * b.h)]);
    },
    async type(text) { await hands(['type'], text); },
    async key(name) { await hands(['key', name]); },
  };
}

/** Chrome's frontmost window, brought to the front first so the click lands on it. This is the same
 *  Chrome the Claude extension drives, so its tabs are reached this way too. */
function macChrome(): Screen {
  let box: Box | null = null;
  const front = async () => {
    await run('/usr/bin/osascript', ['-e', 'tell application "Google Chrome" to activate'], { timeout: 10_000 });
    box = JSON.parse(await hands(['chrome']));
    return box!;
  };
  return {
    async shot() {
      const b = await front();
      const png = await capture(['-o', '-l', String(b.id)]);
      return { png, ...pngSize(png) };
    },
    async tap(fx, fy) {
      const b = await front();
      await hands(['click', String(b.x + fx * b.w), String(b.y + fy * b.h)]);
    },
    async type(text) { await front(); await hands(['type'], text); },
    async key(name) { await front(); await hands(['key', name]); },
  };
}

// ---- the Pi's automation browser, over the DevTools protocol ---------------------------------------

/** The page the browser is showing: the first page target, which is the most recently active tab. */
async function cdpPage(): Promise<WebSocket> {
  const r = await fetch(`${CDP}/json`, { signal: AbortSignal.timeout(10_000) });
  const pages = ((await r.json()) as any[]).filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error(`no page open in the browser at ${CDP}`);
  const ws = new WebSocket(pages[0].webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('error', bad); });
  return ws;
}

async function cdp<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const ws = await cdpPage();
  try {
    const id = 1;
    ws.send(JSON.stringify({ id, method, params }));
    return await new Promise<T>((ok, bad) => {
      const t = setTimeout(() => bad(new Error(`${method} got no answer`)), 20_000);
      ws.on('message', (m) => {
        const msg = JSON.parse(String(m));
        if (msg.id !== id) return;
        clearTimeout(t);
        if (msg.error) bad(new Error(`${method}: ${msg.error.message}`)); else ok(msg.result);
      });
    });
  } finally { ws.close(); }
}

const KEYS: Record<string, { key: string; code: string; keyCode: number }> = {
  enter: { key: 'Enter', code: 'Enter', keyCode: 13 }, tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 }, escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
};

function piBrowser(): Screen {
  return {
    async shot() {
      const { data } = await cdp<{ data: string }>('Page.captureScreenshot', { format: 'png' });
      const png = Buffer.from(data, 'base64');
      return { png, ...pngSize(png) };
    },
    async tap(fx, fy) {
      const m = await cdp<any>('Page.getLayoutMetrics');
      const v = m.cssVisualViewport || m.visualViewport;
      const x = fx * v.clientWidth, y = fy * v.clientHeight;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    },
    async type(text) { await cdp('Input.insertText', { text }); },
    async key(name) {
      const k = KEYS[name];
      if (!k) throw new Error(`unknown key ${name}`);
      for (const type of ['keyDown', 'keyUp']) {
        await cdp('Input.dispatchKeyEvent', { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode,
          ...(name === 'enter' && type === 'keyDown' ? { text: '\r' } : {}) });
      }
    },
  };
}

const SCREENS: Record<string, () => Screen> = { 'mac-screen': macScreen, 'mac-chrome': macChrome, 'pi-browser': piBrowser };
const screens = new Map<string, Screen>();
const screenFor = (target: string) => {
  if (!screens.has(target)) screens.set(target, SCREENS[target]());
  return screens.get(target)!;
};

// ---- the work ---------------------------------------------------------------------------------------

async function publish(handoff: string, target: string, extra: Record<string, unknown> = {}): Promise<void> {
  const f = await screenFor(target).shot();
  const name = `${uuid()}.png`;
  const { error: up } = await getClient().storage.from(BUCKET).upload(name, f.png, { contentType: 'image/png' });
  if (up) throw new Error(`could not store the screenshot: ${up.message}`);
  const { data: cur } = await getClient().from('handoffs').select('seq').eq('id', handoff).single();
  const { error } = await getClient().from('handoffs').update({
    image: name, width: f.width, height: f.height, seq: (cur?.seq || 0) + 1, updated_at: new Date().toISOString(), ...extra,
  }).eq('id', handoff);
  if (error) throw new Error(`could not record the screenshot: ${error.message}`);
}

async function fail(handoff: string, why: string): Promise<void> {
  console.error(`[handoff] ${handoff} failed: ${why}`);
  await getClient().from('handoffs').update({ status: 'failed', error: why.slice(0, 300), updated_at: new Date().toISOString() }).eq('id', handoff);
}

async function opened(row: any): Promise<void> {
  try { await publish(row.id, row.target, { status: 'open' }); }
  catch (e: any) { await fail(row.id, `could not screenshot ${row.target}: ${e.message}`); }
}

async function act(a: any): Promise<void> {
  const sb = getClient();
  const { data: h } = await sb.from('handoffs').select('id,status,target,taps,typed').eq('id', a.handoff).single();
  const finish = async (fields: Record<string, unknown>) => {
    const { error } = await sb.from('handoff_actions').update({ done_at: new Date().toISOString(), text: null, ...fields }).eq('id', a.id);
    if (error) console.error(`[handoff] action ${a.id} not marked done: ${error.message}`);
  };
  if (!h || h.status !== 'open') { await finish({ error: 'handoff is not open' }); return; }
  if (a.kind === 'done' || a.kind === 'cancel') {
    await sb.from('handoffs').update({ status: a.kind === 'done' ? 'done' : 'cancelled', updated_at: new Date().toISOString() }).eq('id', h.id);
    await finish({});
    return;
  }
  const screen = screenFor(h.target);
  try {
    if (a.kind === 'tap') {
      if (!(a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1)) throw new Error('tap outside the screenshot');
      await screen.tap(a.x, a.y);
    } else if (a.kind === 'text') await screen.type(String(a.text || ''));
    else if (a.kind === 'key') await screen.key(String(a.key));
    await finish({});
  } catch (e: any) {
    console.error(`[handoff] ${a.kind} on ${h.target} failed: ${e.message}`);
    await finish({ error: String(e.message).slice(0, 300) });
  }
  if (a.kind !== 'refresh') await new Promise((r) => setTimeout(r, SETTLE_MS));
  const count = a.kind === 'tap' || a.kind === 'key' ? { taps: h.taps + 1 } : a.kind === 'text' ? { typed: h.typed + 1 } : {};
  try { await publish(h.id, h.target, count); }
  catch (e: any) { await fail(h.id, `could not screenshot ${h.target} after a ${a.kind}: ${e.message}`); }
}

/** Answer every handoff for these targets, for the life of the process. */
export function start(targets: string[]): void {
  const unknown = targets.filter((t) => !SCREENS[t]);
  if (unknown.length) throw new Error(`unknown handoff target(s): ${unknown.join(', ')}`);
  if (!targets.length) throw new Error('no handoff targets to answer');
  const mine = (row: any) => targets.includes(row.target);
  onInserts('handoffs', opened, 0, mine);
  onInserts('handoff_actions', act, 0, mine);
  console.log(`[handoff-agent] answering ${targets.join(', ')}`);
}
