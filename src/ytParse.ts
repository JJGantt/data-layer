// What YouTube's pages and its internal API (`youtubei/v1`) return, flattened to rows a model can
// read. Shared by the public reads (youtube.ts) and the signed-in ones (youtubeAccount.ts), because
// both get the same renderer JSON. YouTube moves between renderer shapes without notice, so each
// kind of item is recognised in every shape it has been seen in, old and new.

export type Item = {
  kind: 'video' | 'short' | 'playlist' | 'channel';
  id: string;
  title: string;
  channel?: string;
  length?: string;
  meta: string[];       // views, age, subscriber count: whatever YouTube shows under the title
  watched?: number;     // percent of the video already watched, where YouTube shows the red bar
  section?: string;     // the heading it sits under ("Today", "Yesterday", "Shorts")
};

export const txt = (t: any): string =>
  t == null ? '' : typeof t === 'string' ? t : t.content ?? t.simpleText ?? (t.runs || []).map((r: any) => r.text).join('');

export function* find(o: any, key: string): Generator<any> {
  if (Array.isArray(o)) for (const v of o) yield* find(v, key);
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (k === key) yield v; yield* find(v, key); }
}

const first = (o: any, key: string) => find(o, key).next().value;

function lockup(l: any): Item | null {
  const md = l.metadata?.lockupMetadataViewModel;
  const rows: string[][] = (md?.metadata?.contentMetadataViewModel?.metadataRows || [])
    .map((r: any) => (r.metadataParts || []).map((p: any) => txt(p.text)).filter(Boolean)).filter((r: string[]) => r.length);
  const kind = ({ LOCKUP_CONTENT_TYPE_VIDEO: 'video', LOCKUP_CONTENT_TYPE_PLAYLIST: 'playlist', LOCKUP_CONTENT_TYPE_CHANNEL: 'channel' } as any)[l.contentType];
  if (!kind || !l.contentId) return null;
  const badges = [...find(l.contentImage, 'thumbnailBadgeViewModel')].map((b: any) => b.text).filter(Boolean);
  const bar = first(l.contentImage, 'thumbnailOverlayProgressBarViewModel');
  // The first part is the channel, except where the page is a channel's own (its uploads carry only
  // views and age) or YouTube left the byline off.
  const parts = rows.flat();
  const stat = /^[\d.,]+\s*[KMB]?( views?)?$|ago$|watching|^Streamed|^Premier|views$/i;
  const channel = parts.length && !stat.test(parts[0]) ? parts[0] : undefined;
  const rest = channel ? parts.slice(1) : parts;
  return { kind, id: l.contentId, title: txt(md?.title), channel, length: kind === 'video' ? badges[0] : undefined,
    meta: kind === 'playlist' ? [...badges, ...rest] : rest, watched: bar?.startPercent };
}

function video(v: any): Item {
  const bar = first(v.thumbnailOverlays, 'thumbnailOverlayResumePlaybackRenderer');
  return { kind: 'video', id: v.videoId, title: txt(v.title), channel: txt(v.ownerText || v.shortBylineText || v.longBylineText),
    length: txt(v.lengthText) || undefined,
    meta: [txt(v.viewCountText) || txt(v.shortViewCountText), txt(v.publishedTimeText), ...(v.videoInfo ? [txt(v.videoInfo)] : [])].filter(Boolean),
    watched: bar?.percentDurationWatched };
}

/** Every video, short, playlist and channel in a response, in page order, each under the section
 *  heading it appears beneath. */
export function items(root: any): Item[] {
  const out: Item[] = [];
  const seen = new Set<string>();
  const add = (it: Item | null, section?: string) => {
    if (!it || !it.id || seen.has(it.kind + it.id)) return;
    seen.add(it.kind + it.id);
    out.push(section ? { ...it, section } : it);
  };
  const walk = (o: any, section?: string): void => {
    if (Array.isArray(o)) { for (const v of o) walk(v, section); return; }
    if (!o || typeof o !== 'object') return;
    // A section's heading names everything inside it.
    const head = o.itemSectionRenderer?.header?.itemSectionHeaderRenderer?.title
      ?? o.richSectionRenderer?.content?.richShelfRenderer?.title ?? o.reelShelfRenderer?.title ?? o.shelfRenderer?.title;
    if (head) section = txt(head) || section;
    if (o.lockupViewModel) return add(lockup(o.lockupViewModel), section);
    if (o.videoRenderer || o.gridVideoRenderer || o.compactVideoRenderer || o.playlistVideoRenderer)
      return add(video(o.videoRenderer || o.gridVideoRenderer || o.compactVideoRenderer || o.playlistVideoRenderer), section);
    if (o.shortsLockupViewModel) {
      const s = o.shortsLockupViewModel;
      const id = first(s, 'reelWatchEndpoint')?.videoId;
      return add(id ? { kind: 'short', id, title: txt(s.overlayMetadata?.primaryText), meta: [txt(s.overlayMetadata?.secondaryText)].filter(Boolean) } : null, section);
    }
    if (o.channelRenderer) {
      const c = o.channelRenderer;
      // On the subscriptions page YouTube puts the @handle in subscriberCountText and the subscriber
      // count in videoCountText.
      return add({ kind: 'channel', id: c.channelId, title: txt(c.title),
        meta: [txt(c.subscriberCountText), txt(c.videoCountText)].filter(Boolean) }, section);
    }
    for (const v of Object.values(o)) walk(v, section);
  };
  walk(root);
  return out;
}

/** The token that fetches the next page of a browse, if there is one. */
export function continuation(root: any): string | undefined {
  let token: string | undefined;
  for (const c of find(root, 'continuationItemRenderer')) token = first(c, 'continuationCommand')?.token ?? token;
  return token;
}

export function line(it: Item): string {
  return [it.kind === 'video' ? it.id : `${it.kind} ${it.id}`, it.title, it.channel, it.length, ...it.meta,
    it.watched != null ? `watched ${it.watched}%` : ''].filter(Boolean).join(' | ');
}

/** Rows as text, with a heading line wherever the section changes. */
export function render(list: Item[]): string {
  if (!list.length) return 'Nothing there.';
  const out: string[] = [];
  let section: string | undefined;
  for (const it of list) {
    if (it.section && it.section !== section) { section = it.section; out.push(`\n${section}:`); }
    out.push(line(it));
  }
  return out.join('\n').trim();
}
