// THE OWNER'S OWN YouTube account: watch history, home recommendations, subscriptions, their new
// uploads, Watch Later, liked videos, playlists. Read from YouTube's internal API (`youtubei/v1/browse`), signed in
// with the cookies of the Pi's automation browser (pi-browser repo), which is logged in to the owner's Google
// account. The public API cannot do this: it has had no watch history or recommendations since 2016.
//
// Runs ONLY on the Pi, where that browser is. The cookies are read live over its DevTools port on each
// request and never stored or sent anywhere but youtube.com; the browser keeps them fresh. Every other
// machine reaches this through home_requests (homeRequests.ts), answered by data-http on the Pi.
import crypto from 'node:crypto';
import { items, continuation, render, Item } from './ytParse.js';

const CDP = process.env.PI_BROWSER_CDP || 'http://localhost:9223';
const ORIGIN = 'https://www.youtube.com';
const UA = 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** The browser's cookies for youtube.com, over the DevTools protocol. */
async function cookies(): Promise<{ name: string; value: string }[]> {
  const { webSocketDebuggerUrl } = await (await fetch(`${CDP}/json/version`)).json() as any;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timer = setTimeout(() => { ws.close(); reject(new Error('the Pi browser did not answer')); }, 10_000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Storage.getCookies' }));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('cannot reach the Pi browser')); };
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
  if (!sapisid) throw new Error('the Pi browser is not signed in to YouTube');
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
  if (!JSON.stringify(json.responseContext || {}).includes('"logged_in","value":"1"')) throw new Error('YouTube does not see the Pi browser as signed in');
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
