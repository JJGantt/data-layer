import { createSign } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import './client.js';   // loads .env for scripts that import only this module

// Jared's Apple Music account (`apple_music`): read his library, playlists and recent plays, search the
// catalog, and ADD — songs and albums to the library, favorites, new playlists, songs onto a playlist.
// The Apple Music API cannot delete or rename anything in a library, so nothing here can either.
//
// Two tokens: a developer token, an ES256 JWT signed here with the "Jared Music" MusicKit key, and his
// Music-User-Token, which only MusicKit JS in a browser can mint (~/repos/music/bin/apple-music-login) and
// which lasts about six months. Credentials: APPLE_MUSIC_KEY_ID, APPLE_MUSIC_TEAM_ID,
// APPLE_MUSIC_PRIVATE_KEY (the .p8's PEM, newlines as \n) and APPLE_MUSIC_USER_TOKEN, in each machine's
// environment (README § Apple Music).
//
// Ids: catalog ids (numeric, from `search`) are what add / favorite / playlists take; library ids (`i.…`
// songs, `l.…` albums, `p.…` playlists) are what the library returns, each with its catalog id beside it.

const API = 'https://api.music.apple.com';
export const OPS = ['library', 'playlist', 'recent', 'search', 'add', 'favorite', 'create_playlist', 'add_to_playlist'] as const;
export type Op = typeof OPS[number];
const KINDS = ['songs', 'albums', 'artists', 'playlists'] as const;
type Kind = typeof KINDS[number];

let dev: { value: string; until: number } | null = null;
let sf: string | null = null;

function config(): void {
  const missing = ['APPLE_MUSIC_KEY_ID', 'APPLE_MUSIC_TEAM_ID', 'APPLE_MUSIC_PRIVATE_KEY', 'APPLE_MUSIC_USER_TOKEN']
    .filter((k) => !process.env[k]);
  if (missing.length) {
    const msg = `Apple Music is not configured on this machine: ${missing.join(', ')} not set`;
    console.error(`[apple-music] ${msg}`);
    throw new Error(msg);
  }
}

function developerToken(): string {
  if (dev && dev.until > Date.now() + 60e3) return dev.value;
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b({ alg: 'ES256', kid: process.env.APPLE_MUSIC_KEY_ID, typ: 'JWT' });
  const body = b({ iss: process.env.APPLE_MUSIC_TEAM_ID, iat: now, exp: now + 12 * 3600 });
  const pem = process.env.APPLE_MUSIC_PRIVATE_KEY!.replace(/\\n/g, '\n');
  const sig = createSign('SHA256').update(`${head}.${body}`).sign({ key: pem, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  dev = { value: `${head}.${body}.${sig}`, until: (now + 12 * 3600) * 1000 };
  return dev.value;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One API call. A burst of requests is sometimes answered 401 or 403 "Invalid authentication" with both
 *  tokens valid, clearing within a minute, so those are retried with backoff like a 429 or a 5xx. One that
 *  never clears is almost always the six-month user token having expired. */
async function call(method: string, path: string, params?: Record<string, string | number>, body?: unknown): Promise<any> {
  config();
  const url = new URL(path.startsWith('http') ? path : API + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, String(v));
  let last = 0, detail = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt) await sleep(2000 * 2 ** (attempt - 1));
    const r = await fetch(url, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: {
      Authorization: `Bearer ${developerToken()}`, 'Music-User-Token': process.env.APPLE_MUSIC_USER_TOKEN!,
      'Content-Type': 'application/json' } });
    let raw = Buffer.from(await r.arrayBuffer());
    // Some answers arrive gzipped without saying so.
    if (raw[0] === 0x1f && raw[1] === 0x8b) raw = gunzipSync(raw);
    if (r.ok) return raw.length ? JSON.parse(raw.toString('utf8')) : {};
    last = r.status; detail = raw.toString('utf8').slice(0, 200);
    if (!(r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500)) break;
  }
  const hint = last === 401 || last === 403
    ? ' (if this keeps happening, the Apple Music sign-in has expired: run ~/repos/music/bin/apple-music-login on the Mac and copy the new token to every machine)' : '';
  const msg = `Apple Music ${method} ${url.pathname} -> HTTP ${last} ${detail}${hint}`;
  console.error(`[apple-music] ${msg}`);
  throw new Error(msg);
}

async function storefront(): Promise<string> {
  if (!sf) sf = (await call('GET', '/v1/me/storefront')).data[0].id as string;
  return sf!;
}

const ids = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
  .map((x) => String(x).trim()).filter(Boolean);

function row(x: any): string {
  const a = x.attributes || {};
  const cat = a.playParams?.catalogId;
  const by = a.artistName ? ` — ${a.artistName}` : a.curatorName ? ` — ${a.curatorName}` : '';
  const album = a.albumName ? ` [${a.albumName}]` : '';
  const extra = [a.trackCount ? `${a.trackCount} tracks` : '', a.releaseDate ? a.releaseDate.slice(0, 4) : '',
    a.dateAdded ? `added ${a.dateAdded.slice(0, 10)}` : ''].filter(Boolean).join(', ');
  return `${x.id}${cat && cat !== x.id ? ` (catalog ${cat})` : ''}: ${a.name}${by}${album}${extra ? ` · ${extra}` : ''}`;
}

/** Up to `limit` items from a paged endpoint, starting at `offset`. */
async function pages(path: string, limit: number, offset: number, pageSize: number, params: Record<string, string | number> = {}): Promise<{ items: any[]; more: boolean }> {
  const items: any[] = [];
  let page = await call('GET', path, { ...params, limit: Math.min(pageSize, limit), offset });
  for (;;) {
    items.push(...(page.data || []));
    if (items.length >= limit || !page.next) return { items: items.slice(0, limit), more: !!page.next || items.length > limit };
    page = await call('GET', page.next);
  }
}

function list(title: string, items: any[], more: boolean, offset: number): string {
  if (!items.length) return `${title}: none.`;
  return `${title} (${offset + 1}-${offset + items.length}${more ? ', more after' : ''}):\n` + items.map(row).join('\n');
}

export async function run(op: Op, a: Record<string, any>): Promise<string> {
  const limit = Math.max(1, Math.min(Number(a.limit) || 50, 500));
  const offset = Math.max(0, Number(a.offset) || 0);

  if (op === 'library') {
    const kind = (KINDS.includes(a.kind) ? a.kind : 'songs') as Kind;
    if (a.query) {
      const r = await call('GET', '/v1/me/library/search', { term: String(a.query), types: `library-${kind}`, limit: Math.min(limit, 25) });
      const hits = r.results?.[`library-${kind}`]?.data || [];
      return list(`Library ${kind} matching "${a.query}"`, hits, false, 0);
    }
    const { items, more } = await pages(`/v1/me/library/${kind}`, limit, offset, 100);
    return list(`Library ${kind}`, items, more, offset);
  }
  if (op === 'playlist') {
    if (!a.id) return 'playlist needs `id`, a library playlist id (p.…) from library kind playlists.';
    const { items, more } = await pages(`/v1/me/library/playlists/${encodeURIComponent(a.id)}/tracks`, limit, offset, 100);
    return list(`Playlist ${a.id} tracks`, items, more, offset);
  }
  if (op === 'recent') {
    // Apple keeps only the last ~90 tracks here, with no times on them.
    const { items, more } = await pages('/v1/me/recent/played/tracks', Math.min(limit, 100), offset, 30);
    return list('Recently played, newest first', items, more, offset);
  }
  if (op === 'search') {
    if (!a.query) return 'search needs `query`.';
    const types = (Array.isArray(a.types) && a.types.length ? a.types : ['songs', 'albums', 'artists']).filter((t: string) => KINDS.includes(t as Kind));
    const r = await call('GET', `/v1/catalog/${await storefront()}/search`, { term: String(a.query), types: types.join(','), limit: Math.min(limit, 25) });
    const out = types.map((t: string) => list(`Catalog ${t}`, r.results?.[t]?.data || [], false, 0));
    return out.join('\n\n');
  }
  if (op === 'add') {
    const songs = ids(a.song_ids), albums = ids(a.album_ids);
    if (!songs.length && !albums.length) return 'add needs `song_ids` and/or `album_ids` (catalog ids from search).';
    const params: Record<string, string> = {};
    if (songs.length) params['ids[songs]'] = songs.join(',');
    if (albums.length) params['ids[albums]'] = albums.join(',');
    await call('POST', '/v1/me/library', params);
    return `Added to the library: ${songs.length} song(s), ${albums.length} album(s). Apple takes a minute or so to show them in the library.`;
  }
  if (op === 'favorite') {
    const songs = ids(a.song_ids);
    if (!songs.length) return 'favorite needs `song_ids` (catalog ids).';
    const failed: string[] = [];
    for (const id of songs) {
      try { await call('PUT', `/v1/me/ratings/songs/${encodeURIComponent(id)}`, undefined, { type: 'rating', attributes: { value: 1 } }); }
      catch { failed.push(id); }
    }
    return `Favorited ${songs.length - failed.length}/${songs.length} (they go into his Favorite Songs playlist)` + (failed.length ? `; failed: ${failed.join(', ')}` : '.');
  }
  if (op === 'create_playlist') {
    const name = String(a.name || '').trim();
    if (!name) return 'create_playlist needs `name`.';
    const songs = ids(a.song_ids);
    const attributes: Record<string, string> = { name };
    if (a.description) attributes.description = String(a.description);
    const r = await call('POST', '/v1/me/library/playlists', undefined, { attributes,
      relationships: { tracks: { data: songs.slice(0, 100).map((id) => ({ id, type: 'songs' })) } } });
    const pid = r.data[0].id as string;
    for (let i = 100; i < songs.length; i += 100)
      await call('POST', `/v1/me/library/playlists/${pid}/tracks`, undefined, { data: songs.slice(i, i + 100).map((id) => ({ id, type: 'songs' })) });
    return `Created playlist "${name}" (${pid}) with ${songs.length} song(s).`;
  }
  if (op === 'add_to_playlist') {
    const songs = ids(a.song_ids);
    if (!a.id || !songs.length) return 'add_to_playlist needs `id` (a library playlist id, p.…) and `song_ids` (catalog ids).';
    for (let i = 0; i < songs.length; i += 100)
      await call('POST', `/v1/me/library/playlists/${encodeURIComponent(a.id)}/tracks`, undefined, { data: songs.slice(i, i + 100).map((id) => ({ id, type: 'songs' })) });
    return `Added ${songs.length} song(s) to playlist ${a.id}.`;
  }
  return `Unknown op ${op}.`;
}
