// YouTube, read the way the site itself is: the watch and results pages carry their data as JSON
// (`ytInitialPlayerResponse`, `ytInitialData`) inside a <script>. A generic fetch-to-markdown tool
// (WebFetch) drops scripts and truncates the 1.5MB page, so it never sees a description, chapters or
// a real video id; parsing that JSON does, with no API key. Works from the Mac, the Pi and Fly alike.
//
// Transcripts are NOT available this way: the caption URLs in the player response return an empty
// body, and the transcript endpoint answers FAILED_PRECONDITION, because both now want a token only a
// real browser's player mints.

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

function* find(o: any, key: string): Generator<any> {
  if (Array.isArray(o)) for (const v of o) yield* find(v, key);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === key) yield v; yield* find(v, key); }
}

const txt = (t: any): string => t?.simpleText ?? (t?.runs || []).map((r: any) => r.text).join('');
const clock = (s: number) => { const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; };

/** Videos for a search, in YouTube's order: id, title, channel, length, views, age. */
export async function search(query: string, limit = 10): Promise<string> {
  const html = await page(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`);
  const rows = [...find(embedded(html, 'ytInitialData'), 'videoRenderer')].slice(0, Math.max(1, Math.min(20, limit)));
  if (!rows.length) return 'No videos found.';
  return rows.map((v: any) => [v.videoId, txt(v.title), txt(v.ownerText), v.lengthText?.simpleText || 'live',
    txt(v.viewCountText), txt(v.publishedTimeText)].filter(Boolean).join(' | ')).join('\n');
}

/** One video: title, channel, length, views, date, the full description and its chapters. */
export async function video(id: string): Promise<string> {
  const m = id.match(/(?:v=|youtu\.be\/|shorts\/|live\/)([\w-]{11})/) || id.match(/^([\w-]{11})$/);
  if (!m) return `Not a YouTube video id or URL: ${id}`;
  const html = await page(`https://www.youtube.com/watch?v=${m[1]}&hl=en`);
  const player = embedded(html, 'ytInitialPlayerResponse');
  const d = player?.videoDetails;
  if (!d) return `YouTube returned no details for ${m[1]} (${player?.playabilityStatus?.status || 'no player data'}).`;
  const micro = player.microformat?.playerMicroformatRenderer || {};
  const chapters = [...find(embedded(html, 'ytInitialData'), 'chapterRenderer')]
    .map((c: any) => `${clock(Math.round(c.timeRangeStartMillis / 1000))} ${txt(c.title)}`);
  return [
    `${d.title}`,
    `id ${d.videoId} | ${d.author} | ${clock(Number(d.lengthSeconds))} | ${Number(d.viewCount).toLocaleString('en-US')} views${micro.publishDate ? ` | published ${micro.publishDate.slice(0, 10)}` : ''}`,
    chapters.length ? `\nChapters:\n${[...new Set(chapters)].join('\n')}` : '',
    `\nDescription:\n${d.shortDescription || '(none)'}`,
  ].filter(Boolean).join('\n');
}
