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

/** A screenshot, and the rectangle of the real screen it shows (Mac: points; browser: CSS pixels of the
 *  viewport), which is where a tap at a fraction of it lands. */
type Frame = { png: Buffer; width: number; height: number; rect: Rect };
type Rect = { x: number; y: number; w: number; h: number };
/** What a handoff asked to be shown: `app` (mac-screen), `region` (fractions of the window or page),
 *  `selector` (pi-browser), and Jared's `whole` toggle. */
type Ask = { id: string; target: string; app: string | null; region: Rect | null; selector: string | null; whole: boolean };
interface Screen {
  shot(h: Ask): Promise<Frame>;
  tap(h: Ask, rect: Rect, fx: number, fy: number): Promise<void>;
  type(h: Ask, text: string): Promise<void>;
  key(h: Ask, name: string): Promise<void>;
}

/** A region the session gave, as fractions, clamped to the window or page; null when there is none. */
function regionOf(h: Ask): Rect | null {
  const r = h.region;
  if (h.whole || !r || ![r.x, r.y, r.w, r.h].every(Number.isFinite)) return null;
  const x = Math.min(Math.max(r.x, 0), 1), y = Math.min(Math.max(r.y, 0), 1);
  const w = Math.min(Math.max(r.w, 0.02), 1 - x), h2 = Math.min(Math.max(r.h, 0.02), 1 - y);
  return { x, y, w, h: h2 };
}

// ---- the Mac ---------------------------------------------------------------------------------------

async function hands(args: string[], input?: string): Promise<string> {
  const p = run(HANDS, args, { timeout: 15_000 });
  if (input != null) { p.child.stdin?.end(input); }
  const { stdout } = await p;
  return stdout;
}

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** One window, captured by its id (on whichever display it is), and cut to `crop` (pixels) if given. */
async function captureWindow(id: number, crop: { x: number; y: number; w: number; h: number } | null): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handoff-'));
  const file = path.join(dir, 'shot.png');
  try {
    await run('/usr/sbin/screencapture', ['-x', '-o', '-t', 'png', '-l', String(id), file], { timeout: 15_000 });
    if (crop) {
      await run('/usr/bin/sips', ['-c', String(crop.h), String(crop.w), '--cropOffset', String(crop.y), String(crop.x), file, '--out', file], { timeout: 15_000 });
    }
    return await readFile(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** The front window of one app, brought to the front so a click lands on it. The app is the owner name
 *  `hands windows` lists ('Google Chrome' for mac-chrome). */
function macWindow(fixedApp?: string): Screen {
  const front = async (h: Ask) => {
    const app = fixedApp || h.app;
    if (!app) throw new Error('mac-screen needs the app whose window to show');
    try {
      await run('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(app)} to activate`], { timeout: 10_000 });
    } catch (e: any) {
      // A system dialog's owner (a SecurityAgent prompt) is not an app that takes `activate`; it is
      // already in front, so the capture and the click go ahead.
      console.warn(`[handoff] could not bring ${app} to the front: ${String(e.message).split('\n')[0]}`);
    }
    // An app on another Space has no window on screen until the switch to it finishes, so the window is
    // looked for again for a few seconds before the capture or the click gives up.
    for (let i = 0; ; i++) {
      try { return JSON.parse(await hands(['window', app])) as Rect & { id: number }; }
      catch (e) { if (i >= 10) throw e; await new Promise((r) => setTimeout(r, 300)); }
    }
  };
  return {
    async shot(h) {
      const win = await front(h);
      const r = regionOf(h);
      if (!r) {
        const png = await captureWindow(win.id, null);
        return { png, ...pngSize(png), rect: { x: win.x, y: win.y, w: win.w, h: win.h } };
      }
      // The capture is in pixels, the window in points: crop by the window's own pixel size.
      const full = pngSize(await captureWindow(win.id, null));
      const crop = { x: Math.round(r.x * full.width), y: Math.round(r.y * full.height),
        w: Math.max(1, Math.round(r.w * full.width)), h: Math.max(1, Math.round(r.h * full.height)) };
      const png = await captureWindow(win.id, crop);
      return { png, ...pngSize(png), rect: { x: win.x + r.x * win.w, y: win.y + r.y * win.h, w: r.w * win.w, h: r.h * win.h } };
    },
    async tap(h, rect, fx, fy) {
      // Another app may have come to the front since the screenshot (he went to the Mac): the click is
      // placed on this window, so it is brought back first.
      await front(h);
      await hands(['click', String(rect.x + fx * rect.w), String(rect.y + fy * rect.h)]);
    },
    async type(h, text) { await front(h); await hands(['type'], text); },
    async key(h, name) { await front(h); await hands(['key', name]); },
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

/** Margin around a selector's element, so the field's label and its button come with it. */
const ELEMENT_MARGIN = 24;

function piBrowser(): Screen {
  /** What to show, in viewport CSS pixels: the selector's element (if it is on the page), else the
   *  region, else the whole viewport. */
  async function framing(h: Ask): Promise<{ rect: Rect; scrollX: number; scrollY: number }> {
    const { result } = await cdp<any>('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const vw = innerWidth, vh = innerHeight, el = ${!h.whole && h.selector ? `document.querySelector(${JSON.stringify(h.selector)})` : 'null'};
      const b = el && el.getBoundingClientRect();
      return { vw, vh, sx: scrollX, sy: scrollY, b: b && b.width && b.height ? { x: b.x, y: b.y, w: b.width, h: b.height } : null };
    })()` });
    const v = result.value;
    let rect: Rect = { x: 0, y: 0, w: v.vw, h: v.vh };
    const r = regionOf(h);
    if (v.b) {
      const x = Math.max(0, v.b.x - ELEMENT_MARGIN), y = Math.max(0, v.b.y - ELEMENT_MARGIN);
      rect = { x, y, w: Math.min(v.vw, v.b.x + v.b.w + ELEMENT_MARGIN) - x, h: Math.min(v.vh, v.b.y + v.b.h + ELEMENT_MARGIN) - y };
    } else if (r) rect = { x: r.x * v.vw, y: r.y * v.vh, w: r.w * v.vw, h: r.h * v.vh };
    return { rect, scrollX: v.sx, scrollY: v.sy };
  }
  return {
    async shot(h) {
      const f = await framing(h);
      // The clip is in page coordinates, the framing in the viewport's: offset by the scroll.
      const { data } = await cdp<{ data: string }>('Page.captureScreenshot', { format: 'png',
        clip: { x: f.rect.x + f.scrollX, y: f.rect.y + f.scrollY, width: f.rect.w, height: f.rect.h, scale: 1 } });
      const png = Buffer.from(data, 'base64');
      return { png, ...pngSize(png), rect: f.rect };
    },
    async tap(_h, rect, fx, fy) {
      const x = rect.x + fx * rect.w, y = rect.y + fy * rect.h;
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      }
    },
    async type(_h, text) { await cdp('Input.insertText', { text }); },
    async key(_h, name) {
      const k = KEYS[name];
      if (!k) throw new Error(`unknown key ${name}`);
      for (const type of ['keyDown', 'keyUp']) {
        await cdp('Input.dispatchKeyEvent', { type, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode,
          ...(name === 'enter' && type === 'keyDown' ? { text: '\r' } : {}) });
      }
    },
  };
}

const SCREENS: Record<string, () => Screen> = {
  'mac-screen': () => macWindow(), 'mac-chrome': () => macWindow('Google Chrome'), 'pi-browser': piBrowser,
};
const screens = new Map<string, Screen>();
const screenFor = (target: string) => {
  if (!screens.has(target)) screens.set(target, SCREENS[target]());
  return screens.get(target)!;
};
/** The rectangle each handoff's newest screenshot shows, which is what its next tap is measured in. */
const shown = new Map<string, Rect>();

// ---- the work ---------------------------------------------------------------------------------------

const ASK = 'id,target,app,region,selector,whole';

async function publish(h: Ask, extra: Record<string, unknown> = {}): Promise<void> {
  const handoff = h.id;
  const f = await screenFor(h.target).shot(h);
  shown.set(handoff, f.rect);
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
  try { await publish(row, { status: 'open' }); }
  catch (e: any) { await fail(row.id, `could not screenshot ${row.target}: ${e.message}`); }
}

async function act(a: any): Promise<void> {
  const sb = getClient();
  const { data: h } = await sb.from('handoffs').select(`${ASK},status,taps,typed`).eq('id', a.handoff).single();
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
      const rect = shown.get(h.id);
      if (!rect) throw new Error('no screenshot of this handoff taken here to place the tap on');
      await screen.tap(h, rect, a.x, a.y);
    } else if (a.kind === 'text') await screen.type(h, String(a.text || ''));
    else if (a.kind === 'key') await screen.key(h, String(a.key));
    else if (a.kind === 'view') {
      h.whole = !h.whole;
      await sb.from('handoffs').update({ whole: h.whole }).eq('id', h.id);
    }
    await finish({});
  } catch (e: any) {
    console.error(`[handoff] ${a.kind} on ${h.target} failed: ${e.message}`);
    await finish({ error: String(e.message).slice(0, 300) });
  }
  if (a.kind !== 'refresh' && a.kind !== 'view') await new Promise((r) => setTimeout(r, SETTLE_MS));
  const count = a.kind === 'tap' || a.kind === 'key' ? { taps: h.taps + 1 } : a.kind === 'text' ? { typed: h.typed + 1 } : {};
  try { await publish(h, count); }
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
