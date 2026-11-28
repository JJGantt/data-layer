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
import { cropPng, diffFraction } from './pngDiff.js';
import { endedMessage } from './handoff.js';
import { followUp } from './desk.js';

const run = promisify(execFile);

const HANDS = process.env.HANDS_BIN || path.join(process.cwd(), 'hands/bin/hands');
const CDP = process.env.HANDOFF_CDP || 'http://127.0.0.1:9223';
/**
 * A click starts something the screen shows a moment later (a page loading, a menu opening), and no
 * event says "the screen has finished changing". So the screenshot after an action waits this long;
 * a result still in motion is what the Refresh button is for.
 */
const SETTLE_MS = Number(process.env.HANDOFF_SETTLE_MS || 1200);

/** A screenshot of the whole screen (Mac: the display; browser: the viewport), the rectangle of the real
 *  screen it shows (points / CSS pixels), which is where a tap at a fraction of it lands, and `focus`:
 *  the part that matters (a region or an element), as fractions of it, or null. */
type Frame = { png: Buffer; width: number; height: number; rect: Rect; focus: Rect | null };
type Rect = { x: number; y: number; w: number; h: number };
/** What a handoff asked to be shown: `app` (mac-screen), `region` (fractions of the screen or page),
 *  `selector` (pi-browser), and Jared's `whole` toggle. */
type Ask = { id: string; target: string; app: string | null; region: Rect | null; selector: string | null; whole: boolean;
  session?: string | null; window_id?: number | null };
interface Screen {
  shot(h: Ask): Promise<Frame>;
  tap(h: Ask, rect: Rect, fx: number, fy: number): Promise<void>;
  type(h: Ask, text: string): Promise<void>;
  key(h: Ask, name: string): Promise<void>;
  /** Bring what the handoff is about to the front, without capturing it (a screen share opening on it). */
  show?(h: Ask): Promise<void>;
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

async function hands(args: string[], input?: string, timeout = 15_000): Promise<string> {
  const p = run(HANDS, args, { timeout });
  if (input != null) { p.child.stdin?.end(input); }
  const { stdout } = await p;
  return stdout;
}

function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** The screen inside `rect` (points, global coordinates), captured as it shows there. Capturing the
 *  rectangle rather than a window id is what keeps the picture and the tap mapping the same area: a
 *  window captured by id can come back larger than the bounds the window list gives it (full-screen
 *  Chrome's page window captures with its tab strip and toolbar above it), so a tap placed by fraction
 *  of those bounds would land offset from what he tapped on. */
async function captureRect(rect: Rect): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'handoff-'));
  const file = path.join(dir, 'shot.png');
  try {
    const r = [rect.x, rect.y, rect.w, rect.h].map((v) => Math.round(v)).join(',');
    await run('/usr/sbin/screencapture', ['-x', '-t', 'png', `-R${r}`, file], { timeout: 15_000 });
    return await readFile(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

// A mac-chrome handoff shows THE TAB OF THE SESSION THAT ASKED, not whatever window Chrome has in front: a
// session's Claude tabs live in their own group, often in a window behind his own, and bringing Chrome
// forward put him on a YouTube tab while the sign-in waited elsewhere. Each session's Chrome tool results
// are recorded on the Mac by claude-config `mac/bin/chrome-tabs` (~/.claude/chrome-tabs/<claude session id>,
// a tab id a line, newest last), and Chrome's AppleScript tab ids are the extension's, so the newest one
// recorded is selected and its window raised. With no record (a session that never used Chrome) it is
// Chrome's front window, as before, and that is logged.
const tabOf = new Map<string, number | null>();   // handoff id -> its session's tab, looked up once
async function sessionTab(h: Ask): Promise<number | null> {
  if (tabOf.has(h.id)) return tabOf.get(h.id)!;
  let tab: number | null = null;
  try {
    if (h.session) {
      const { data } = await getClient().from('desk_sessions').select('claude_session_id').eq('id', h.session).maybeSingle();
      const csid = data?.claude_session_id;
      if (csid) {
        const lines = (await readFile(path.join(process.env.HOME || '', '.claude/chrome-tabs', csid), 'utf8')).split('\n');
        const ids = lines.slice(1).map((l) => Number(l.trim())).filter((n) => Number.isInteger(n) && n > 0);
        tab = ids.length ? ids[ids.length - 1] : null;
      }
    }
  } catch (e: any) { if (e.code !== 'ENOENT') console.error(`[handoff] ${h.id}: reading its session's Chrome tabs failed: ${e.message}`); }
  if (tab == null) console.warn(`[handoff] ${h.id}: no Chrome tab recorded for session ${h.session}; showing Chrome's front window`);
  tabOf.set(h.id, tab);
  return tab;
}

// TWO CHROMES CAN BE RUNNING: his own, which the Claude extension drives, and an on-demand one started with
// its own --user-data-dir (the YouTube sign-in browser, data-layer youtubeAccount.ts). AppleScript's
// "Google Chrome" then resolves to either, and `activate` raised the YouTube one: he signed in to Google
// there while the session's Tuya tab waited in the other. So his Chrome is found by PID — the main
// `Google Chrome` process started without --user-data-dir — and raised by that pid (`hands activate`).
async function mainChromePid(): Promise<number | null> {
  const { stdout } = await run('/usr/bin/pgrep', ['-x', 'Google Chrome']).catch(() => ({ stdout: '' }));
  for (const pid of stdout.split('\n').map((l) => Number(l.trim())).filter((n) => n > 0)) {
    const { stdout: args } = await run('/bin/ps', ['-o', 'args=', '-p', String(pid)]).catch(() => ({ stdout: '' }));
    if (args && !/--user-data-dir/.test(args)) return pid;
  }
  return null;
}
async function raisePid(pid: number): Promise<void> { await hands(['activate', String(pid)]); }


/** The app brought to the front so what he taps on is its window, and the screen area its windows cover. The app is the owner name
 *  `hands windows` lists ('Google Chrome' for mac-chrome). */
function macWindow(fixedApp?: string): Screen {
  const front = async (h: Ask) => {
    const app = fixedApp || h.app;
    if (!app) throw new Error('mac-screen needs the app whose window to show');
    // A SYSTEM AUTHENTICATION DIALOG ON SCREEN WINS. It floats above every app, so it is what he sees and
    // taps on whatever the handoff named, and raising that app beneath it moves the keyboard focus to the
    // app: his tap on the dialog's field would land, and his typing then go into the window behind it.
    // So nothing is raised while one is up, and the screen it is on is the one shown.
    const dialog = (await hands(['dialog']).catch(() => '')).trim();
    if (dialog) return { ...JSON.parse(dialog), dialog: true } as Rect & { dialog?: boolean };
    if (h.target === 'mac-chrome') {
      const pid = await mainChromePid();
      if (!pid) throw new Error('his Chrome is not running');
      const tab = await sessionTab(h);
      // The tab is selected in THAT Chrome, by pid (`hands chrome-tab`); a tab it cannot find is logged
      // and his Chrome is raised as it stands.
      if (tab != null) {
        // Selecting a tab is an Apple Event, which macOS holds until he answers its one-time "control
        // Google Chrome" prompt: 4 s and the handoff goes on without it rather than waiting on him.
        const out = await hands(['chrome-tab', String(pid), String(tab)], undefined, 4_000).catch((e: any) => String(e.message));
        if (out.trim() !== 'ok') console.warn(`[handoff] ${h.id}: could not select tab ${tab} (${out.trim().slice(0, 80)}); raising Chrome pid ${pid} as it is`);
      }
      await raisePid(pid);
    } else if (h.window_id) {
      // ITS window, raised by id, never the app's front one: another session's window of the same app can
      // be in front, and showing or typing into that one is the failure this exists for. A window that is
      // gone ends the handoff rather than falling back to whichever window is there now.
      try { return JSON.parse(await hands(['raise', String(h.window_id)])) as Rect; }
      catch (e: any) { throw new Error(`its window (${app}, ${h.window_id}) is gone: ${String(e.stderr || e.message).trim().split('\n')[0]}`); }
    } else try {
      await run('/usr/bin/osascript', ['-e', `tell application ${JSON.stringify(app)} to activate`], { timeout: 10_000 });
    } catch (e: any) {
      // A system dialog's owner (a SecurityAgent prompt) is not an app that takes `activate`; it is
      // already in front, so the capture and the click go ahead.
      console.warn(`[handoff] could not bring ${app} to the front: ${String(e.message).split('\n')[0]}`);
    }
    // An app on another Space has no window on screen until the switch to it finishes, so the window is
    // looked for again for a few seconds. An app with none at all (Keychain Access between its password
    // prompts, whose dialog another process draws) is null: the handoff then shows the main display as it
    // stands rather than failing, since what he is asked about is on screen, just not in that app's window.
    for (let i = 0; ; i++) {
      try { return JSON.parse(await hands(['window', app])) as Rect; }
      catch (e: any) {
        if (i >= 6) { console.warn(`[handoff] ${h.id}: ${app} has no window on screen; showing the main display`); return null; }
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  };
  return {
    async shot(h) {
      // The whole display the app is on, or the part of it the session asked for. The app is only
      // brought to the front; what he sees and taps on is the screen itself.
      const win = await front(h);
      const at = win ? [win.x + win.w / 2, win.y + win.h / 2] : [1, 1];   // no window: the main display
      const scr = JSON.parse(await hands(['screen', String(at[0]), String(at[1])])) as Rect;
      const png = await captureRect(scr);
      // Framed on the dialog when one is up: it is what he has to answer, wherever the session's region was.
      const d = win && (win as any).dialog ? win : null;
      const focus = d ? { x: Math.max(0, (d.x - scr.x) / scr.w - 0.03), y: Math.max(0, (d.y - scr.y) / scr.h - 0.03),
        w: Math.min(1, d.w / scr.w + 0.06), h: Math.min(1, d.h / scr.h + 0.06) } : regionOf(h);
      return { png, ...pngSize(png), rect: scr, focus };
    },
    async tap(h, rect, fx, fy) {
      // Another app may have come to the front since the screenshot (he went to the Mac): the click is
      // meant for this app, so it is brought back first.
      await front(h);
      await hands(['click', String(rect.x + fx * rect.w), String(rect.y + fy * rect.h)]);
    },
    async type(h, text) { await front(h); await hands(['type'], text); },
    async key(h, name) { await front(h); await hands(['key', name]); },
    async show(h) { await front(h); },
  };
}

/** The ids of an app's windows on screen now that hold content, front first. A full-screen app has a
 *  second, untitled window for its tab bar (Terminal's is 1280x68 at the top), which is never the one. */
async function windowIds(app: string): Promise<number[]> {
  const out = await hands(['windows']);
  return out.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    .filter((w) => w.app === app && w.h >= 120 && w.w >= 120).map((w) => Number(w.id));
}

/** Whether `hands raise` can bring that window forward (it exists and Accessibility reaches it). */
async function raises(id: number): Promise<boolean> {
  try { await hands(['raise', String(id)]); return true; } catch { return false; }
}

/**
 * The window a mac-screen ask is for, chosen when it opens: the newest window of that app this session
 * itself had (a Terminal it drove), else that app's front window at the moment it asked. Only a window
 * `hands raise` can actually reach is recorded; with none (a system dialog's owner, which Accessibility
 * does not raise) the handoff shows the app as it stands, as before.
 */
async function pickWindow(h: Ask): Promise<number | null> {
  if (h.target !== 'mac-screen' || !h.app || h.window_id) return h.window_id || null;
  if (h.session) {
    const { data } = await getClient().from('handoffs').select('window_id').eq('session', h.session).eq('app', h.app)
      .not('window_id', 'is', null).neq('id', h.id).order('created_at', { ascending: false }).limit(1);
    const mine = data?.[0]?.window_id;
    if (mine && await raises(Number(mine))) return Number(mine);
  }
  for (const id of await windowIds(h.app).catch(() => [] as number[])) if (await raises(id)) return id;
  console.warn(`[handoff] ${h.id}: no window of ${h.app} it can raise; showing the app as it stands`);
  return null;
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
  /** The viewport, and what matters in it as fractions of it: the selector's element (if it is on the
   *  page), else the region, else nothing. */
  async function framing(h: Ask): Promise<{ vw: number; vh: number; focus: Rect | null; scrollX: number; scrollY: number }> {
    const { result } = await cdp<any>('Runtime.evaluate', { returnByValue: true, expression: `(() => {
      const vw = innerWidth, vh = innerHeight, el = ${!h.whole && h.selector ? `document.querySelector(${JSON.stringify(h.selector)})` : 'null'};
      const b = el && el.getBoundingClientRect();
      return { vw, vh, sx: scrollX, sy: scrollY, b: b && b.width && b.height ? { x: b.x, y: b.y, w: b.width, h: b.height } : null };
    })()` });
    const v = result.value;
    let focus = regionOf(h);
    if (v.b) {
      const x = Math.max(0, v.b.x - ELEMENT_MARGIN), y = Math.max(0, v.b.y - ELEMENT_MARGIN);
      const w = Math.min(v.vw, v.b.x + v.b.w + ELEMENT_MARGIN) - x, hh = Math.min(v.vh, v.b.y + v.b.h + ELEMENT_MARGIN) - y;
      focus = w > 0 && hh > 0 ? { x: x / v.vw, y: y / v.vh, w: w / v.vw, h: hh / v.vh } : focus;
    }
    return { vw: v.vw, vh: v.vh, focus, scrollX: v.sx, scrollY: v.sy };
  }
  return {
    async shot(h) {
      const f = await framing(h);
      // The clip is in page coordinates, the framing in the viewport's: offset by the scroll.
      const { data } = await cdp<{ data: string }>('Page.captureScreenshot', { format: 'png',
        clip: { x: f.scrollX, y: f.scrollY, width: f.vw, height: f.vh, scale: 1 } });
      const png = Buffer.from(data, 'base64');
      return { png, ...pngSize(png), rect: { x: 0, y: 0, w: f.vw, h: f.vh }, focus: f.focus };
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
/** Each handoff's newest screenshot of the whole screen and the rectangle it shows, and the rectangle of
 *  `image` (the cropped picture the watch shows): what his next tap is measured in (the phone taps on
 *  the whole screen, the watch on `image`), and what the screen is checked against before anything is
 *  done there. */
const shown = new Map<string, { full: Rect; rect: Rect; png: Buffer }>();

// A HANDOFF HE NEVER ANSWERS EXPIRES: an open handoff is a start that needs an end, and one left for hours
// is re-screenshotted on every restart and keeps a session asleep for nothing. EXPIRE_MS after its last
// ACTIVITY — when it opened, or the last thing he did on it (a handoff_actions row) — it is cancelled as
// expired, its session is told, and that is counted. A screenshot is not activity: the agent takes one of
// every open handoff when it starts, and counting those would keep a forgotten one alive forever.
// A timer held for that moment: the clock is the event here.
const EXPIRE_MS = Number(process.env.HANDOFF_EXPIRE_MS || 30 * 60_000);
const expiries = new Map<string, NodeJS.Timeout>();
function arm(handoff: string, last = Date.now()): void {
  clearTimeout(expiries.get(handoff));
  expiries.set(handoff, setTimeout(() => expire(handoff).catch((e: any) => console.error(`[handoff] ${handoff}: expiring failed: ${e.message}`)),
    Math.max(0, last + EXPIRE_MS - Date.now())));
}
async function lastActivity(handoff: string, created: string, active?: string | null): Promise<number> {
  const { data } = await getClient().from('handoff_actions').select('created_at').eq('handoff', handoff)
    .order('created_at', { ascending: false }).limit(1);
  return Math.max(Date.parse(created), active ? Date.parse(active) : 0, data?.[0] ? Date.parse(data[0].created_at) : 0);
}
async function expire(handoff: string): Promise<void> {
  expiries.delete(handoff);
  const { data: r } = await getClient().from('handoffs').select('status,created_at,active_at').eq('id', handoff).single();
  if (!r || r.status !== 'open') return;
  const last = await lastActivity(handoff, r.created_at, r.active_at);
  const idle = Date.now() - last;
  if (idle < EXPIRE_MS) { arm(handoff, last); return; }   // acted on since the timer was set
  console.warn(`[handoff] ${handoff} expired: no answer in ${Math.round(idle / 60_000)} min`);
  await getClient().from('handoffs').update({ status: 'cancelled', error: `expired: no answer in ${Math.round(EXPIRE_MS / 60_000)} min`,
    suggest: null, updated_at: new Date().toISOString() }).eq('id', handoff);
  await tellSession(handoff);
}

/**
 * A tap or typing is acted on only while the screen still looks like the screenshot he made it on. A
 * window moved or resized, another one in front, a page that scrolled or navigated: any of them puts
 * the tap somewhere he did not mean, so the action is dropped and he is sent the screen as it is now.
 * The tolerance lets a blinking caret or a small animation through and stops anything larger.
 */
const CHANGED = Number(process.env.HANDOFF_CHANGED_FRACTION || 0.05);
const sameRect = (a: Rect, b: Rect) => ['x', 'y', 'w', 'h'].every((k) => Math.abs((a as any)[k] - (b as any)[k]) <= 2);

// ---- the work ---------------------------------------------------------------------------------------

const ASK = 'id,target,app,region,selector,whole,session,driver,window_id';

// ONE AT A TIME ON ONE SCREEN. The Mac's display has one keyboard focus, so two sessions' asks open on it
// at once take each other's typing (one session's keychain dialog held the focus while another's sign-in
// was on his phone). An ask that arrives while another is open on the same screen is `queued`: no
// screenshot, no push. When the one in front ends, the oldest queued one opens (`promote`). Both Mac
// targets are one screen; a session's own drives (driver 'session') are not asks and never queue.
const screenOf = (target: string) => (target.startsWith('mac-') ? 'mac' : target);
const sameScreen = (target: string) => Object.keys(SCREENS).filter((t) => screenOf(t) === screenOf(target));
let answering: string[] = [];

async function frontAsk(target: string, except?: string): Promise<string | null> {
  let q = getClient().from('handoffs').select('id').is('driver', null).eq('status', 'open').in('target', sameScreen(target));
  if (except) q = q.neq('id', except);
  const { data, error } = await q.limit(1);
  if (error) throw new Error(`could not read the open handoffs: ${error.message}`);
  return data?.[0]?.id || null;
}

/**
 * A session waits on one ask at a time (handoff.ts `supersede` does this when it asks; this is the same rule
 * kept by the agent, so a session whose tools predate it, and asks left open across a restart, obey it
 * too): every other ask of that session still waiting is ended, quietly, since it is the one asking again.
 */
async function retireOlder(session: string, keep: string): Promise<void> {
  const why = 'superseded: the session asked again';
  const { data, error } = await getClient().from('handoffs').select('id').eq('session', session).is('driver', null)
    .in('status', ['new', 'queued', 'open']).neq('id', keep).in('target', answering);
  if (error) throw new Error(`could not read session ${session}'s other handoffs: ${error.message}`);
  for (const h of data || []) {
    await getClient().from('handoffs').update({ status: 'cancelled', error: why, suggest: null, updated_at: new Date().toISOString() })
      .eq('id', h.id).in('status', ['new', 'queued', 'open']);
    console.log(`[handoff] ${h.id} ${why} (${keep})`);
    await tellSession(h.id, true);
  }
}

/**
 * Whether a new ask on that screen can open now. Only an ask he is WORKING on holds the line: one with no
 * activity for ACTIVE_MS (an action, share input, being opened) is put back in the queue and the new one
 * opens, because an ask nobody is touching held the screen and his newest one never reached him.
 */
const ACTIVE_MS = Number(process.env.HANDOFF_ACTIVE_MS || 2 * 60_000);
async function takeFront(target: string, id: string): Promise<boolean> {
  const cur = await frontAsk(target, id);
  if (!cur) return true;
  const { data: r } = await getClient().from('handoffs').select('created_at,active_at').eq('id', cur).single();
  if (r && Date.now() - await lastActivity(cur, r.created_at, r.active_at) < ACTIVE_MS) return false;
  await getClient().from('handoffs').update({ status: 'queued', updated_at: new Date().toISOString() }).eq('id', cur).eq('status', 'open');
  clearTimeout(expiries.get(cur)); expiries.delete(cur);
  console.log(`[handoff] ${cur} idle: back in the queue so ${id} can open`);
  return true;
}

/** Open the oldest queued ask on that screen when none is open there. */
async function promote(target: string): Promise<void> {
  if (await frontAsk(target)) return;
  const { data } = await getClient().from('handoffs').select(`${ASK},status`).eq('status', 'queued')
    .in('target', sameScreen(target).filter((t) => answering.includes(t))).order('created_at', { ascending: true }).limit(1);
  const h = data?.[0];
  if (!h) return;
  console.log(`[handoff] ${h.id} opens from the queue`);
  const active_at = new Date().toISOString();
  try {
    h.window_id = await pickWindow(h);
    await publish(h, { status: 'open', active_at, window_id: h.window_id });
    arm(h.id);
  } catch (e: any) { await fail(h.id, `could not screenshot ${h.target}: ${e.message}`); }
}

async function publish(h: Ask, extra: Record<string, unknown> = {}): Promise<void> {
  const handoff = h.id;
  const f = await screenFor(h.target).shot(h);
  // The phone gets the whole screen and frames the focus itself, so he can pinch out to the rest. The
  // watch has no room for that: `image` is the focus alone (or everything, after his Full toggle).
  const crop = f.focus && !h.whole ? cropPng(f.png, f.focus) : null;
  const fo = crop ? f.focus! : null;
  shown.set(handoff, { full: f.rect, png: f.png, rect: fo
    ? { x: f.rect.x + fo.x * f.rect.w, y: f.rect.y + fo.y * f.rect.h, w: fo.w * f.rect.w, h: fo.h * f.rect.h } : f.rect });
  const store = async (png: Buffer) => {
    const name = `${uuid()}.png`;
    const { error: up } = await getClient().storage.from(BUCKET).upload(name, png, { contentType: 'image/png' });
    if (up) throw new Error(`could not store the screenshot: ${up.message}`);
    return name;
  };
  // Where his typing will go (Mac): the focused field, in fractions of the whole screen, so the phone can
  // outline it and name it before he types. Read after the capture, from the same moment.
  let typing_into: Record<string, unknown> | null = null;
  if (h.target.startsWith('mac-')) {
    try {
      const out = (await hands(['focused'])).trim();
      if (out) {
        const z = JSON.parse(out);
        if (z.w > 0 && z.h > 0 && /Text|Combo|Search/.test(z.role)) typing_into = { label: z.label || null, secure: !!z.secure,
          x: (z.x - f.rect.x) / f.rect.w, y: (z.y - f.rect.y) / f.rect.h, w: z.w / f.rect.w, h: z.h / f.rect.h };
      }
    } catch (e: any) { console.error(`[handoff] ${handoff}: could not read where typing goes: ${e.message}`); }
  }
  const full = await store(f.png);
  const image = crop ? await store(crop) : full;
  const size = crop ? pngSize(crop) : { width: f.width, height: f.height };
  const { data: cur } = await getClient().from('handoffs').select('seq').eq('id', handoff).single();
  const { error } = await getClient().from('handoffs').update({
    image, ...size, full_image: full, focus: f.focus, typing_into, seq: (cur?.seq || 0) + 1, updated_at: new Date().toISOString(), ...extra,
  }).eq('id', handoff);
  if (error) throw new Error(`could not record the screenshot: ${error.message}`);
  if (!expiries.has(handoff)) arm(handoff);
}

async function fail(handoff: string, why: string): Promise<void> {
  console.error(`[handoff] ${handoff} failed: ${why}`);
  await getClient().from('handoffs').update({ status: 'failed', error: why.slice(0, 300), suggest: null, updated_at: new Date().toISOString() }).eq('id', handoff);
  await tellSession(handoff);
}

// The Terminal window a drive_screen session opened, by handoff: its tty, so the window can be closed
// when the drive ends however it ends (closed, failed, expired). This agent has no Automation grant for
// Terminal, so the Mac orchestrator closes it (`close_window`), and only while it holds nothing but an
// idle shell: a command the session left running there keeps the window open.
const terminalWindows = new Map<string, string>();

/** The ttys every Terminal login shell is on now. */
async function loginTtys(): Promise<Set<string>> {
  const { stdout } = await run('/bin/ps', ['-Ao', 'tty=,comm='], { timeout: 5_000 });
  return new Set(stdout.split('\n').map((l) => l.trim().split(/\s+/))
    .filter(([tty, comm]) => tty && tty !== '??' && comm === 'login').map(([tty]) => `/dev/${tty}`));
}

async function closeTerminalOf(handoff: string): Promise<void> {
  const tty = terminalWindows.get(handoff);
  if (!tty) return;
  terminalWindows.delete(handoff);
  const { error } = await getClient().from('desk_commands')
    .insert({ id: uuid(), kind: 'close_window', payload: { tty, target: 'mac' } });
  if (error) console.error(`[handoff] ${handoff} ended but its Terminal window on ${tty} was not asked to close: ${error.message}`);
}

/** The session that asked is not waiting on the handoff (handoff.ts): this message is what wakes it. Every
 *  end passes through here, so it is also where the next queued ask on that screen opens. An end the
 *  session made itself (`bySession`: it asked again, or closed it on seeing the step done) is not sent
 *  back to it. */
async function tellSession(handoff: string, bySession = false): Promise<void> {
  try { await told(handoff, bySession); }
  finally {
    const { data } = await getClient().from('handoffs').select('target').eq('id', handoff).maybeSingle();
    if (data) await promote(data.target).catch((e: any) => console.error(`[handoff] opening the next queued handoff after ${handoff} failed: ${e.message}`));
  }
}
async function told(handoff: string, bySession: boolean): Promise<void> {
  await closeTerminalOf(handoff);
  shown.delete(handoff);
  clearTimeout(expiries.get(handoff)); expiries.delete(handoff);
  const { data: r, error } = await getClient().from('handoffs')
    .select('id,status,taps,typed,error,seq,note,session,driver').eq('id', handoff).single();
  if (error || !r) { console.error(`[handoff] ${handoff} ended but could not be read to tell its session: ${error?.message}`); return; }
  if (!r.session) return;   // a caller with no session waited on the row itself
  if (r.driver === 'session' || bySession) return;   // the session ended it itself and already knows
  const sent = await followUp(endedMessage(r), r.session).catch((e: any) => ({ ok: false as const, error: String(e.message || e) }));
  if (!sent.ok) console.error(`[handoff] ${handoff} ended (${r.status}) but session ${r.session} was not told: ${sent.error}`);
}

/** Seconds since the Mac last had keyboard or mouse input, or null where that cannot be read. */
async function idleSeconds(): Promise<number | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 5_000, maxBuffer: 8 << 20 });
    const m = stdout.match(/"HIDIdleTime" = (\d+)/);
    return m ? Math.floor(Number(m[1]) / 1e9) : null;
  } catch (e: any) { console.error(`[handoff] could not read idle time: ${e.message}`); return null; }
}

async function opened(row: any): Promise<void> {
  // A screen a session drives is opened with how long he has been away from it, read before the first
  // action posts input of its own, so the session can leave a screen he is using alone.
  const idle = row.driver === 'session' && row.target.startsWith('mac-') ? { idle_s: await idleSeconds() } : {};
  // A session driving Terminal gets a window of its own, so its typing can never land in one that is
  // running something else (another session's prompt, his shell).
  if (row.driver === 'session' && row.target === 'mac-screen' && row.app === 'Terminal') {
    try {
      const before = await loginTtys();
      const wins = new Set(await windowIds('Terminal').catch(() => [] as number[]));
      // `open -a Terminal <folder>` opens a new window at that folder and brings it forward. AppleScript's
      // `do script` would too, but the agent has no Automation grant for Terminal, so it fails.
      await run('/usr/bin/open', ['-a', 'Terminal', process.env.HOME || '/Users/jaredgantt'], { timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 800));   // the new window is drawn before the first screenshot
      // Its shell, to close the window by when the drive ends. Exactly one new one, or none is recorded:
      // a guess could name a window something else opened in the same moment.
      const fresh = [...await loginTtys()].filter((t) => !before.has(t));
      if (fresh.length === 1) terminalWindows.set(row.id, fresh[0]);
      else console.warn(`[handoff] ${row.id}: ${fresh.length} new Terminal shells after opening one, so its window is not closed at the end`);
      // Its window, so a handoff of this screen later shows and types into this window and no other.
      const made = (await windowIds('Terminal').catch(() => [] as number[])).filter((w) => !wins.has(w));
      if (made.length === 1) row.window_id = made[0];
      else console.warn(`[handoff] ${row.id}: ${made.length} new Terminal windows after opening one, so it is not tied to one`);
    } catch (e: any) { await fail(row.id, `could not open a Terminal window: ${e.message}`); return; }
  }
  try {
    if (!row.driver && row.session) await retireOlder(row.session, row.id);
    if (!row.driver && !(await takeFront(row.target, row.id))) {
      console.log(`[handoff] ${row.id} queued behind another handoff on ${screenOf(row.target)}, which he is working on`);
      await getClient().from('handoffs').update({ status: 'queued', updated_at: new Date().toISOString() }).eq('id', row.id).eq('status', 'new');
      return;
    }
    const win = row.driver ? (row.window_id || null) : await pickWindow(row);
    row.window_id = win;
    await publish(row, { status: 'open', ...idle, ...(win ? { window_id: win } : {}) });
  } catch (e: any) { await fail(row.id, `could not screenshot ${row.target}: ${e.message}`); }
}

async function act(a: any): Promise<void> {
  const sb = getClient();
  const { data: h } = await sb.from('handoffs').select(`${ASK},status,taps,typed`).eq('id', a.handoff).single();
  const finish = async (fields: Record<string, unknown>) => {
    const { error } = await sb.from('handoff_actions').update({ done_at: new Date().toISOString(), text: null, ...fields }).eq('id', a.id);
    if (error) console.error(`[handoff] action ${a.id} not marked done: ${error.message}`);
  };
  const ending = a.kind === 'done' || a.kind === 'cancel';
  if (!h || !(h.status === 'open' || (ending && h.status === 'queued'))) { await finish({ error: `handoff is ${h ? h.status : 'missing'}` }); return; }
  if (h.status === 'open') arm(h.id);   // something was done on it: the expiry counts from now
  if (ending) {
    const bySession = a.source === 'session';
    await sb.from('handoffs').update({ status: a.kind === 'done' ? 'done' : 'cancelled', suggest: null, updated_at: new Date().toISOString(),
      ...(bySession && a.text ? { error: String(a.text).slice(0, 300) } : {}) }).eq('id', h.id);
    await finish({});
    await tellSession(h.id, bySession);
    return;
  }
  const screen = screenFor(h.target);
  // Typing and keys from a session go to the focus it set up itself (a fresh Terminal window, a field it
  // tapped), not to a spot it read off a screenshot, so they are not checked against one: a window that
  // keeps changing (a command's output) would otherwise refuse every keystroke. His are always checked,
  // and so is every tap, whose spot means something only on the screenshot it was measured on.
  const checked = a.kind === 'tap' || ((a.kind === 'text' || a.kind === 'key') && h.driver !== 'session');
  if (checked) {
    const before = shown.get(h.id);
    // No screenshot held for it here (this agent restarted while it was open): the action could not be
    // checked against what he saw, so nothing is done and he gets the screen as it is now, as when the
    // screen changed. Ending the handoff for it would wake the session over the agent's own restart.
    if (!before) {
      console.log(`[handoff] ${h.id} ${a.kind} dropped: no screenshot held here; sending a fresh one`);
      await finish({ error: 'no screenshot to check against; here is the screen now' });
      try { await publish(h); } catch (e: any) { await fail(h.id, `could not screenshot ${h.target}: ${e.message}`); }
      return;
    }
    try {
      const now = await screen.shot(h);
      const moved = !sameRect(before.full, now.rect);
      const diff = moved ? 1 : diffFraction(before.png, now.png);
      if (moved || diff > CHANGED) {
        // Not an error: the screen moving under him is ordinary. He gets the screen as it is now.
        console.log(`[handoff] ${h.id} ${a.kind} dropped: the screen changed (${moved ? 'window moved' : `${Math.round(diff * 100)}% of it`})`);
        await finish({ error: 'the screen changed since that screenshot; nothing was done' });
        await publish(h);
        return;
      }
    } catch (e: any) {
      await finish({ error: String(e.message).slice(0, 300) });
      await fail(h.id, `could not check ${h.target} before a ${a.kind}: ${e.message}`);
      return;
    }
  }
  try {
    if (a.kind === 'tap') {
      if (!(a.x >= 0 && a.x <= 1 && a.y >= 0 && a.y <= 1)) throw new Error('tap outside the screenshot');
      const s = shown.get(h.id)!;
      await screen.tap(h, a.full ? s.full : s.rect, a.x, a.y);
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
  answering = targets;
  const mine = (row: any) => targets.includes(row.target);
  onInserts('handoffs', opened, 0, mine);
  // A handoff left open across a restart has no screenshot held here: one is taken now, so his next tap
  // is checked against a screen this agent has seen.
  // One already past its expiry is expired instead, without a screenshot.
  getClient().from('handoffs').select(`${ASK},status,created_at,active_at`).in('status', ['open', 'queued']).in('target', targets)
    .order('created_at', { ascending: false })
    .then(async ({ data, error }) => {
      if (error) { console.error(`[handoff] could not read open handoffs at start: ${error.message}`); return; }
      // Asks left across the restart obey the same rules as new ones: each session's newest ask only, and
      // on each screen the newest ask in front with the rest queued (the restart waits for no share to be
      // open, so nobody is in the middle of one).
      const sb = getClient();
      const newest = new Map<string, string>(), front = new Set<string>();
      const live: any[] = [];
      for (const h of (data || []) as any[]) {   // newest first
        if (h.driver) { if (h.status === 'open') live.push(h); continue; }
        if (h.session && newest.has(h.session)) {
          await sb.from('handoffs').update({ status: 'cancelled', error: 'superseded: the session asked again', suggest: null,
            updated_at: new Date().toISOString() }).eq('id', h.id).in('status', ['open', 'queued']);
          console.log(`[handoff] ${h.id} superseded at start by ${newest.get(h.session)}`);
          continue;
        }
        if (h.session) newest.set(h.session, h.id);
        const scr = screenOf(h.target);
        if (front.has(scr)) {
          if (h.status === 'open') {
            await sb.from('handoffs').update({ status: 'queued', updated_at: new Date().toISOString() }).eq('id', h.id).eq('status', 'open');
            console.log(`[handoff] ${h.id} queued at start behind a newer handoff on ${scr}`);
          }
          continue;
        }
        front.add(scr);
        if (h.status === 'queued') {
          try {
            h.window_id = await pickWindow(h);
            await publish(h, { status: 'open', active_at: new Date().toISOString(), window_id: h.window_id });
            arm(h.id);
            console.log(`[handoff] ${h.id} opened at start, the newest on ${scr}`);
          } catch (e: any) { await fail(h.id, `could not screenshot ${h.target}: ${e.message}`); }
          continue;
        }
        live.push(h);
      }
      for (const h of live) {
        const last = await lastActivity(h.id, h.created_at, h.active_at);
        if (Date.now() - last >= EXPIRE_MS) { expire(h.id).catch((e: any) => console.error(`[handoff] ${h.id}: expiring failed: ${e.message}`)); continue; }
        arm(h.id, last);
        publish(h).catch((e: any) => console.error(`[handoff] ${h.id}: fresh screenshot at start failed: ${e.message}`));
      }
      // One that ended while this agent was down left the next in line queued.
      for (const t of new Set(targets.map(screenOf))) {
        const any = targets.find((x) => screenOf(x) === t)!;
        await promote(any).catch((e: any) => console.error(`[handoff] opening queued handoffs at start failed: ${e.message}`));
      }
    });
  onInserts('handoff_actions', act, 0, mine);
  console.log(`[handoff-agent] answering ${targets.join(', ')}`);
}

// INPUT THROUGH A LIVE SCREEN SHARE (screenAgent.ts) is activity on the handoff it stands beside, the
// share's own handoff or else the ask open on that screen: it keeps it from expiring and counts in its taps
// and typing, as the same input from the tap screen does. Serialized per handoff so no count is lost.
const inputChain = new Map<string, Promise<void>>();
export function shareInput(handoff: string | null, kind: string): void {
  const key = handoff || 'mac';
  const next = (inputChain.get(key) || Promise.resolve()).then(async () => {
    const sb = getClient();
    let id = handoff;
    if (id) {
      const { data } = await sb.from('handoffs').select('status').eq('id', id).maybeSingle();
      if (data?.status !== 'open') id = null;
    }
    id ||= await frontAsk('mac-screen');
    if (!id) return;
    const { data: h } = await sb.from('handoffs').select('taps,typed').eq('id', id).single();
    if (!h) return;
    const count = kind === 'text' ? { typed: (h.typed || 0) + 1 } : { taps: (h.taps || 0) + 1 };
    const { error } = await sb.from('handoffs').update({ ...count, active_at: new Date().toISOString() }).eq('id', id).eq('status', 'open');
    if (error) throw new Error(error.message);
    arm(id);
  }).catch((e: any) => console.error(`[handoff] screen-share input on ${handoff || 'the open handoff'} not recorded: ${e.message}`));
  inputChain.set(key, next);
}

/** A screen share opening on a handoff brings that handoff's window forward, so the share starts on it. */
export async function showHandoff(id: string): Promise<void> {
  const { data: h } = await getClient().from('handoffs').select(`${ASK},status`).eq('id', id).maybeSingle();
  if (!h || h.status !== 'open') return;
  const screen = screenFor(h.target);
  if (screen.show) await screen.show(h);
}
