import './client.js';   // loads .env for scripts that import only this module

// The owner's YouTube account through the official YouTube Data API v3, signed in with OAuth
// (bin/youtube-authorize.mjs, scope `youtube`). It reads subscriptions, liked videos and playlists, and
// WRITES: like or unlike a video, subscribe or unsubscribe a channel, make a playlist, add to one.
//
// Watch history, home recommendations, the subscription feed and Watch Later are not in the Data API
// (Google removed history and Watch Later in 2016; recommendations were never there), so those stay with
// the browser (youtubeAccount.ts). The reads here have no browser in the path, so they work from any
// machine, the Pi down or not.
//
// Credentials: YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, in each machine's
// environment (README § YouTube). Quota: 10,000 units a day; a read is 1, a write 50.

const API = 'https://www.googleapis.com/youtube/v3';
export const READS = ['subscriptions', 'liked', 'playlists', 'playlist'] as const;
export const WRITES = ['like', 'unlike', 'subscribe', 'unsubscribe', 'create_playlist', 'add_to_playlist'] as const;
export type Op = typeof READS[number] | typeof WRITES[number];

export const configured = () => !!(process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET && process.env.YOUTUBE_REFRESH_TOKEN);

let access: { token: string; until: number } | null = null;

async function token(): Promise<string> {
  if (access && access.until > Date.now() + 60e3) return access.token;
  if (!configured()) throw new Error('the YouTube API is not configured on this machine: YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN not set');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: process.env.YOUTUBE_CLIENT_ID!, client_secret: process.env.YOUTUBE_CLIENT_SECRET!,
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN!, grant_type: 'refresh_token' }),
  });
  const j: any = await r.json();
  if (!j.access_token) throw new Error(`YouTube sign-in refresh failed: ${j.error || r.status} ${j.error_description || ''}`.trim());
  access = { token: j.access_token, until: Date.now() + (j.expires_in || 3600) * 1000 };
  return access.token;
}

async function call(method: string, path: string, params: Record<string, string | number> = {}, body?: unknown): Promise<any> {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204) return {};
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`YouTube API ${method} ${path} answered ${r.status}: ${j.error?.message || ''}`.trim());
  return j;
}

/** Every page of a list call, up to `limit` items. */
async function pages(path: string, params: Record<string, string | number>, limit: number): Promise<any[]> {
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const j = await call('GET', path, { ...params, maxResults: 50, ...(pageToken ? { pageToken } : {}) });
    out.push(...(j.items || []));
    pageToken = j.nextPageToken;
  } while (pageToken && out.length < limit);
  return out.slice(0, limit);
}

const videoId = (s: string) => (s.match(/(?:v=|youtu\.be\/|shorts\/|^)([\w-]{11})(?:$|[&?#/])/) || [])[1];

/** A channel id (UC…) from an id, an @handle, or a channel URL. */
async function channelId(s: string): Promise<string> {
  const id = (s.match(/(UC[\w-]{22})/) || [])[1];
  if (id) return id;
  const handle = (s.match(/@([\w.-]+)/) || [])[1];
  if (!handle) throw new Error(`not a channel id or @handle: ${s}`);
  const j = await call('GET', '/channels', { part: 'id', forHandle: handle });
  if (!j.items?.length) throw new Error(`no channel @${handle}`);
  return j.items[0].id;
}

export async function run(op: Op, a: { id?: string; limit?: number; name?: string; description?: string; video?: string }): Promise<string> {
  const limit = Math.max(1, Math.min(1000, Math.round(a.limit || 50)));
  switch (op) {
    case 'subscriptions': {
      const items = await pages('/subscriptions', { part: 'snippet', mine: 'true', order: 'alphabetical' }, 1000);
      return `${items.length} subscriptions:\n` + items.map((s) => `${s.snippet.resourceId.channelId} | ${s.snippet.title}`).join('\n');
    }
    case 'liked': {
      const items = await pages('/videos', { part: 'snippet,contentDetails', myRating: 'like' }, limit);
      return items.length ? items.map((v) => `${v.id} | ${v.snippet.title} | ${v.snippet.channelTitle}`).join('\n') : 'No liked videos.';
    }
    case 'playlists': {
      const items = await pages('/playlists', { part: 'snippet,contentDetails,status', mine: 'true' }, 200);
      return items.length ? items.map((p) => `${p.id} | ${p.snippet.title} | ${p.contentDetails.itemCount} videos | ${p.status.privacyStatus}`).join('\n') : 'No playlists.';
    }
    case 'playlist': {
      if (!a.id) throw new Error('playlist needs an id (from playlists).');
      const items = await pages('/playlistItems', { part: 'snippet', playlistId: a.id }, limit);
      return items.map((i) => `${i.snippet.resourceId.videoId} | ${i.snippet.title} | ${i.snippet.videoOwnerChannelTitle || ''}`).join('\n') || 'The playlist is empty.';
    }
    case 'like': case 'unlike': {
      const v = videoId(a.id || '');
      if (!v) throw new Error(`${op} needs a video id or URL`);
      await call('POST', '/videos/rate', { id: v, rating: op === 'like' ? 'like' : 'none' });
      const check = await call('GET', '/videos/getRating', { id: v });
      const now = check.items?.[0]?.rating;
      if (now !== (op === 'like' ? 'like' : 'none')) throw new Error(`${op} ${v} did not take: YouTube reports rating ${now}`);
      return `${op === 'like' ? 'Liked' : 'Removed the like on'} ${v}.`;
    }
    case 'subscribe': {
      const ch = await channelId(a.id || '');
      try {
        const j = await call('POST', '/subscriptions', { part: 'snippet' }, { snippet: { resourceId: { kind: 'youtube#channel', channelId: ch } } });
        return `Subscribed to ${j.snippet?.title || ch} (${ch}).`;
      } catch (e: any) {
        if (/subscriptionDuplicate|already/i.test(e.message)) return `Already subscribed to ${ch}.`;
        throw e;
      }
    }
    case 'unsubscribe': {
      const ch = await channelId(a.id || '');
      const j = await call('GET', '/subscriptions', { part: 'id,snippet', mine: 'true', forChannelId: ch });
      if (!j.items?.length) return `Not subscribed to ${ch}.`;
      await call('DELETE', '/subscriptions', { id: j.items[0].id });
      return `Unsubscribed from ${j.items[0].snippet.title} (${ch}).`;
    }
    case 'create_playlist': {
      if (!a.name) throw new Error('create_playlist needs a name');
      const j = await call('POST', '/playlists', { part: 'snippet,status' },
        { snippet: { title: a.name, description: a.description || '' }, status: { privacyStatus: 'private' } });
      return `Made the private playlist "${a.name}" (${j.id}).`;
    }
    case 'add_to_playlist': {
      const v = videoId(a.video || '');
      if (!a.id || !v) throw new Error('add_to_playlist needs the playlist id and a video id or URL');
      await call('POST', '/playlistItems', { part: 'snippet' }, { snippet: { playlistId: a.id, resourceId: { kind: 'youtube#video', videoId: v } } });
      return `Added ${v} to playlist ${a.id}.`;
    }
  }
}
