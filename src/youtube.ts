// YouTube's public side, read the way the site itself is: the watch, results and channel pages carry
// their data as JSON (`ytInitialPlayerResponse`, `ytInitialData`) inside a <script>. A generic
// fetch-to-markdown tool (WebFetch) drops scripts and truncates the 1.5MB page, so it never sees a
// description, chapters or a real video id; parsing that JSON does, with no API key. Works from the
// Mac, the Pi and Fly alike. Jared's own account (history, recommendations) is youtubeAccount.ts.
//
// Transcripts are NOT available this way: the caption URLs in the player response return an empty
// body, and the transcript endpoint answers FAILED_PRECONDITION, because both now want a token only a
// real browser's player mints.
import { find, items, render, txt } from './ytParse.js';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function page(url: string): Promise<string> {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`YouTube answered ${r.status}`);
  return r.text();
}

/** The object literal assigned to `name` in the page, found by brace matching (a regex cannot know
 *  where a 1MB object ends, and the JSON holds braces inside strings). */
function embedded(html: string, name: string): any {
  const at = html.search(new RegExp(`(?:var |window\\[")?${name}"?\\]?\\s*=\\s*\\{`));
  if (at < 0) return null;
  const start = html.indexOf('{', at);
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return JSON.parse(html.slice(start, i + 1));
  }
  return null;
}

const clock = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; };
const clamp = (n: number | undefined, d: number) => Math.max(1, Math.min(50, Math.round(n || d)));

function videoId(s: string): string | null {
  const m = s.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

/** Videos (and channels, playlists) for a search, in YouTube's order. */
export async function search(query: string, limit?: number): Promise<string> {
  const html = await page(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`);
  return render(items(embedded(html, 'ytInitialData')).filter((it) => it.kind !== 'short').slice(0, clamp(limit, 10)));
}

/** One video: title, channel, length, views, date, the full description and its chapters. */
export async function video(id: string): Promise<string> {
  const v = videoId(id);
  if (!v) return `Not a YouTube video id or URL: ${id}`;
  const html = await page(`https://www.youtube.com/watch?v=${v}&hl=en`);
  const player = embedded(html, 'ytInitialPlayerResponse');
  const d = player?.videoDetails;
  if (!d) return `YouTube returned no details for ${v} (${player?.playabilityStatus?.status || 'no player data'}).`;
  const micro = player.microformat?.playerMicroformatRenderer || {};
  const chapters = [...find(embedded(html, 'ytInitialData'), 'chapterRenderer')]
    .map((c: any) => `${clock(Math.round(c.timeRangeStartMillis / 1000))} ${txt(c.title)}`);
  return [
    `${d.title}`,
    `id ${d.videoId} | ${d.author} (channel ${d.channelId}) | ${clock(Number(d.lengthSeconds))} | ${Number(d.viewCount).toLocaleString('en-US')} views${micro.publishDate ? ` | published ${micro.publishDate.slice(0, 10)}` : ''}${d.isLiveContent ? ' | live' : ''}`,
    micro.category ? `category ${micro.category}` : '',
    chapters.length ? `\nChapters:\n${[...new Set(chapters)].join('\n')}` : '',
    `\nDescription:\n${d.shortDescription || '(none)'}`,
  ].filter(Boolean).join('\n');
}

/** What YouTube suggests watching after a video (the watch page's side column). */
export async function related(id: string, limit?: number): Promise<string> {
  const v = videoId(id);
  if (!v) return `Not a YouTube video id or URL: ${id}`;
  const data = embedded(await page(`https://www.youtube.com/watch?v=${v}&hl=en`), 'ytInitialData');
  const side = data?.contents?.twoColumnWatchNextResults?.secondaryResults;
  return render(items(side).filter((it) => it.id !== v && it.kind !== 'short').slice(0, clamp(limit, 15)));
}

/** A channel's newest uploads. `channel` is an @handle, a channel id (UC…) or a channel URL. */
export async function channel(channel: string, limit?: number): Promise<string> {
  const c = channel.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/.*$/, '');
  const path = /^UC[\w-]{22}$/.test(c) ? `channel/${c}` : `@${c.replace(/^@/, '')}`;
  const data = embedded(await page(`https://www.youtube.com/${path}/videos?hl=en`), 'ytInitialData');
  const name = txt(data?.metadata?.channelMetadataRenderer?.title) || data?.metadata?.channelMetadataRenderer?.title;
  if (!data) return `No channel at youtube.com/${path}.`;
  const desc = data?.metadata?.channelMetadataRenderer?.description;
  return [`${name || path}${desc ? `\n${desc.slice(0, 400)}` : ''}`, '', 'Newest uploads:',
    render(items(data).filter((it) => it.kind === 'video').slice(0, clamp(limit, 15)))].join('\n');
}
