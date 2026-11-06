// THE OWNER'S OWN YouTube account: watch history, home recommendations, subscriptions, their new
// uploads, Watch Later, liked videos, playlists. Read from YouTube's internal API (`youtubei/v1/browse`), signed in
// with the cookies of a browser logged in to the owner's Google account. The public API cannot do this: it
// has had no watch history or recommendations since 2016.
//
// Two machines can answer, through home_requests (homeRequests.ts); every other machine asks.
//   - The Pi (data-http): its always-on automation browser (pi-browser repo), DevTools on :9223.
//   - The Mac (homeAgent.ts), only when the Pi has not claimed the request: a dedicated Chrome profile
//     (YT_BROWSER_PROFILE), started headless on demand and quit after ten idle minutes. It is not his
//     everyday Chrome, whose cookies sit behind the login keychain; it was signed in to Google once by hand.
// The cookies are read live over DevTools on each request and never stored or sent anywhere but
// youtube.com; the browser keeps them fresh.
import crypto from 'node:crypto';
import { spawn, ChildProcess } from 'node:child_process';
import { items, continuation, render, Item } from './ytParse.js';

const CDP = process.env.YT_BROWSER_CDP || 'http://localhost:9223';
const PROFILE = process.env.YT_BROWSER_PROFILE;
const CHROME = process.env.YT_BROWSER_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const IDLE_MS = 10 * 60_000;
const ORIGIN = 'https://www.youtube.com';
const UA = process.platform === 'darwin'
  ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  : 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

let launched: ChildProcess | undefined;
let idle: NodeJS.Timeout | undefined;

const debuggerUrl = async (): Promise<string> =>
  ((await (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(3000) })).json()) as any).webSocketDebuggerUrl;

/** The browser's DevTools socket, starting the on-demand one (YT_BROWSER_PROFILE) if it is not running.
 *  Opening youtube.com at start lets Google rotate the session cookies, which only a page load does. */
async function browser(): Promise<string> {
  try { return await debuggerUrl(); } catch (e: any) {
    if (!PROFILE) throw new Error(`cannot reach the browser at ${CDP}: ${e.message}`);
  }
  launched = spawn(CHROME, ['--headless=new', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${new URL(CDP).port}`,
    '--use-mock-keychain', '--no-first-run', '--no-default-browser-check', `--user-agent=${UA}`, ORIGIN], { stdio: 'ignore' });
  launched.on('exit', () => { launched = undefined; });
  for (let i = 0; i < 30 && launched; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { return await debuggerUrl(); } catch { /* still starting: the loop retries for 15s */ }
  }
  launched?.kill();
  throw new Error(`the browser for ${PROFILE} did not start (is a window still open on that profile?)`);
}

/** The browser's cookies for youtube.com, over the DevTools protocol. */
async function cookies(): Promise<{ name: string; value: string }[]> {
  const ws = new WebSocket(await browser());
  if (launched) { clearTimeout(idle); idle = setTimeout(() => launched?.kill(), IDLE_MS); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('the browser did not answer')); }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('cannot reach the browser')); };
    ws.onmessage = (m) => {
      const r = JSON.parse(String(m.data));
      if (r.id !== 1) return;
      clearTimeout(timer); ws.close();
      resolve((r.result?.cookies || []).filter((c: any) => /(^|\.)youtube\.com$/.test(c.domain)));
    };
  });
}

let clientVersion: string | undefined;

async function browse(body: Record<string, unknown>): Promise<any> {
  const jar = await cookies();
  const sapisid = jar.find((c) => c.name === 'SAPISID')?.value;
  if (!sapisid) throw new Error('the browser is not signed in to YouTube');
  // The web client's version, as the site itself reports it; an old one keeps working for months,
  // but this never has to be edited by hand.
  clientVersion ??= ((await (await fetch(ORIGIN, { headers: { 'User-Agent': UA } })).text())
    .match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1] || '2.20251020.00.00';
  const ts = Math.floor(Date.now() / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${sapisid} ${ORIGIN}`).digest('hex');
  const r = await fetch(`${ORIGIN}/youtubei/v1/browse?prettyPrint=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: jar.map((c) => `${c.name}=${c.value}`).join('; '),
      Authorization: `SAPISIDHASH ${ts}_${hash}`, Origin: ORIGIN, 'X-Origin': ORIGIN, 'User-Agent': UA },
    body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' } }, ...body }),
  });
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
  const json = await r.json();
  if (!JSON.stringify(json.responseContext || {}).includes('"logged_in","value":"1"')) throw new Error('YouTube does not see the browser as signed in');
  return json;
}

/** A browse page and as many continuation pages as it takes to reach `limit` items. */
async function collect(browseId: string, limit: number, keep: (it: Item) => boolean = () => true): Promise<Item[]> {
  let page = await browse({ browseId });
  const out: Item[] = [];
  for (let pages = 0; pages < 20; pages++) {
    for (const it of items(page)) if (keep(it) && !out.some((o) => o.kind === it.kind && o.id === it.id)) out.push(it);
    const next = continuation(page);
    if (out.length >= limit || !next) break;
    page = await browse({ continuation: next });
  }
  return out.slice(0, limit);
}

export const OPS = ['history', 'home', 'subscriptions', 'subscription_feed', 'watch_later', 'liked', 'playlists', 'playlist'] as const;
export type Op = (typeof OPS)[number];

export async function account(op: Op, args: { limit?: number; id?: string; shorts?: boolean }): Promise<string> {
  const limit = Math.max(1, Math.min(1000, Math.round(args.limit || 50)));
  const noShorts = (it: Item) => args.shorts || it.kind !== 'short';
  switch (op) {
    case 'history': return render(await collect('FEhistory', limit, noShorts));
    case 'home': return render(await collect('FEwhat_to_watch', limit, noShorts));
    case 'subscriptions': return render(await collect('FEchannels', 1000, (it) => it.kind === 'channel'));
    case 'subscription_feed': return render(await collect('FEsubscriptions', limit, noShorts));
    case 'watch_later': return render(await collect('VLWL', limit));
    case 'liked': return render(await collect('VLLL', limit));
    case 'playlists': return render(await collect('FEplaylist_aggregation', 200, (it) => it.kind === 'playlist'));
    case 'playlist': {
      if (!args.id) return 'playlist needs an id (from playlists).';
      return render(await collect(`VL${args.id.replace(/^VL/, '')}`, limit));
    }
  }
}
