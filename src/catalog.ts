// What is streaming where: one catalog across Netflix, Prime Video, Apple TV+, Disney+, Hulu, Max and
// the rest, from JustWatch's GraphQL API (the one its own site uses; no key). Search, a title's full
// details, episodes, what is popular or newly added on given services, and for every offer the
// Android TV deep link that opens that title in the service's app on the bedroom TV
// (bedroom_tv `open`). Unofficial: if JustWatch changes the schema, this is where it breaks.
import { getClient } from './client.js';

const API = 'https://apis.justwatch.com/graphql';
const LANG = 'country: US, language: "en"';

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
    body: JSON.stringify({ query, variables }) });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j.errors) throw new Error(`JustWatch: ${j.errors?.[0]?.message || r.status}`);
  return j.data;
}

// Spoken service names → JustWatch's package codes. `technicalName` (in results) is the
// key the TV app map and the subscriptions setting use.
export const SERVICES: Record<string, { code: string; tv?: string }> = {
  netflix: { code: 'nfx', tv: 'com.netflix.ninja' },
  amazonprime: { code: 'amp', tv: 'com.amazon.amazonvideo.livingroom' },
  appletvplus: { code: 'atp', tv: 'com.apple.atve.androidtv.appletv' },
  disneyplus: { code: 'dnp', tv: 'com.disney.disneyplus' },
  hulu: { code: 'hlu', tv: 'com.hulu.livingroomplus' },
  max: { code: 'mxx', tv: 'com.wbd.stream' },
  peacocktv: { code: 'pct' },
  paramountplus: { code: 'pmp' },
  tubitv: { code: 'tbv', tv: 'com.tubitv' },
  youtubefree: { code: 'yfr', tv: 'com.google.android.youtube.tv' },
  amcplus: { code: 'acp' },
  criterionchannel: { code: 'crc' },
  mubi: { code: 'mbi' },
  starz: { code: 'stz' },
};

export const GENRES: Record<string, string> = {
  act: 'action', ani: 'animation', cmy: 'comedy', crm: 'crime', doc: 'documentary', drm: 'drama',
  eur: 'european', fml: 'family', fnt: 'fantasy', hst: 'history', hrr: 'horror', msc: 'music',
  rly: 'reality', rma: 'romance', scf: 'sci-fi', spt: 'sport', trl: 'thriller', war: 'war', wsn: 'western',
};
const GENRE_CODE = Object.fromEntries(Object.entries(GENRES).map(([k, v]) => [v, k]));

/** The user's subscribed services (app_settings `streaming_services`, a JSON array of the keys above), or
 *  null when they have not been set. */
export async function mine(): Promise<string[] | null> {
  const { data } = await getClient().from('app_settings').select('value').eq('key', 'streaming_services').maybeSingle();
  if (!data?.value) return null;
  try { const v = typeof data.value === 'string' ? JSON.parse(data.value) : data.value; return Array.isArray(v) ? v : null; } catch { return null; }
}

const OFFER = `offers(country: US, platform: WEB) { monetizationType presentationType retailPrice(language: "en") standardWebURL deeplinkURL(platform: ANDROID_TV) package { technicalName clearName } }`;
const CONTENT = `content(${LANG}) { title originalReleaseYear shortDescription runtime ageCertification genres { shortName } scoring { imdbScore imdbVotes } }`;

/** A deep link the TV can open: JustWatch's Android TV one, given the app's package when it lacks it. */
function tvLink(o: any): string | undefined {
  const pkg = SERVICES[o.package.technicalName]?.tv;
  let link: string | undefined = o.deeplinkURL;
  if (link && pkg && !/;package=/.test(link)) link = link.replace(/;end$/, `;package=${pkg};end`);
  if (!link && pkg && o.standardWebURL) link = o.standardWebURL;
  return link;
}

/** One line per service, best offer kind first: subscription, free, ads, then rent and buy with price. */
function where(offers: any[], my: string[] | null, links: boolean): string[] {
  const rank: Record<string, number> = { FLATRATE: 0, FREE: 1, ADS: 2, RENT: 3, BUY: 4 };
  const best = new Map<string, any>();
  for (const o of [...(offers || [])].sort((a, b) => (rank[a.monetizationType] ?? 9) - (rank[b.monetizationType] ?? 9))) {
    const k = o.package.technicalName;
    if (!best.has(k)) best.set(k, o);
  }
  return [...best.values()].map((o) => {
    const kind = ({ FLATRATE: 'included', FREE: 'free', ADS: 'free with ads', RENT: `rent ${o.retailPrice || ''}`, BUY: `buy ${o.retailPrice || ''}` } as any)[o.monetizationType] || o.monetizationType;
    const his = my?.includes(o.package.technicalName) ? ' (his)' : '';
    const link = links ? tvLink(o) : undefined;
    return `  ${o.package.clearName} [${o.package.technicalName}]${his}: ${kind.trim()}${link ? `\n    open: ${link}` : ''}`;
  });
}

function head(n: any): string {
  const c = n.content || {};
  const genres = (c.genres || []).map((g: any) => GENRES[g.shortName] || g.shortName).join(', ');
  const imdb = c.scoring?.imdbScore ? `IMDb ${c.scoring.imdbScore} (${Number(c.scoring.imdbVotes || 0).toLocaleString('en-US')})` : '';
  const seasons = n.totalSeasonCount ? `${n.totalSeasonCount} season${n.totalSeasonCount > 1 ? 's' : ''}` : '';
  return [`${n.id} ${n.objectType === 'SHOW' ? 'show' : 'movie'}: ${c.title} (${c.originalReleaseYear ?? '?'})`,
    [imdb, c.ageCertification, c.runtime ? `${c.runtime} min` : '', seasons, genres].filter(Boolean).join(' | ')].join('\n  ');
}

const types = (t?: string) => (t === 'movie' ? ['MOVIE'] : t === 'show' ? ['SHOW'] : ['MOVIE', 'SHOW']);

export async function search(query: string, opts: { type?: string; limit?: number } = {}): Promise<string> {
  const my = await mine();
  const d = await gql(`query($q: String!, $n: Int!, $t: [ObjectType!]) { popularTitles(country: US, first: $n, filter: { searchQuery: $q, objectTypes: $t }) {
    edges { node { id objectType ${CONTENT} ... on Show { totalSeasonCount } ${OFFER} } } } }`,
    { q: query, n: Math.max(1, Math.min(20, opts.limit || 8)), t: types(opts.type) });
  const rows = d.popularTitles.edges.map((e: any) => [head(e.node), ...where(e.node.offers, my, false)].join('\n'));
  return rows.length ? rows.join('\n\n') : 'No titles found.';
}

/** Everything about one title: description, cast, seasons, and every offer with its TV deep link. */
export async function title(id: string): Promise<string> {
  const my = await mine();
  const d = await gql(`query($id: ID!) { node(id: $id) { id ... on MovieOrShow { objectType content(${LANG}) { title originalReleaseYear shortDescription runtime ageCertification
    genres { shortName } scoring { imdbScore imdbVotes } credits { role name characterName } backdrops { backdropUrl } posterUrl } } ${OFFER} }
    ... on Show { totalSeasonCount seasons { id totalEpisodeCount content(${LANG}) { seasonNumber } } } } }`, { id });
  const n = d.node;
  if (!n?.content) return `No title ${id}.`;
  const cast = (n.content.credits || []).filter((c: any) => c.role === 'ACTOR').slice(0, 8).map((c: any) => c.name).join(', ');
  const directors = (n.content.credits || []).filter((c: any) => c.role === 'DIRECTOR').slice(0, 3).map((c: any) => c.name).join(', ');
  // JustWatch's image paths are templates; s640 is its 640px-wide size. A backdrop is landscape, which is
  // the shape of a picks-screen card (tv_picks); the poster is the fallback.
  const art = n.content.backdrops?.[0]?.backdropUrl || n.content.posterUrl;
  const image = art ? `https://images.justwatch.com${art.replace('{profile}', 's640').replace('{format}', 'jpg')}` : '';
  return [head(n), '', n.content.shortDescription || '',
    image ? `Image: ${image}` : '',
    cast ? `\nCast: ${cast}` : '', directors ? `Directed by: ${directors}` : '',
    n.seasons?.length ? `\nSeasons:\n${n.seasons.map((s: any) => `  ${s.id} season ${s.content.seasonNumber}: ${s.totalEpisodeCount} episodes`).join('\n')}` : '',
    `\nWhere (${my ? '"his" = a service he has' : 'his services are not set'}):`, ...where(n.offers, my, true)].filter((x) => x !== '').join('\n');
}

/** A season's episodes, each with its own deep links (a season id from `title`). */
export async function episodes(seasonId: string): Promise<string> {
  const my = await mine();
  const d = await gql(`query($id: ID!) { node(id: $id) { ... on Season { content(${LANG}) { title } show { content(${LANG}) { title } }
    episodes { id content(${LANG}) { episodeNumber title shortDescription runtime } ${OFFER} } } } }`, { id: seasonId });
  const s = d.node;
  if (!s?.episodes) return `No season ${seasonId}.`;
  return [`${s.show?.content?.title}: ${s.content?.title}`, ...s.episodes.map((e: any) =>
    [`\nE${e.content.episodeNumber} ${e.content.title}${e.content.runtime ? ` (${e.content.runtime} min)` : ''}`,
      `  ${e.content.shortDescription || ''}`, ...where(e.offers, my, true).filter((l) => /included|free/.test(l))].join('\n'))].join('\n');
}

const pkgs = async (services?: string[]) => {
  const list = services?.length ? services : (await mine()) || [];
  const codes = list.map((s) => SERVICES[s]?.code).filter(Boolean);
  if (list.length && !codes.length) throw new Error(`Unknown services ${list.join(', ')}; known: ${Object.keys(SERVICES).join(', ')}`);
  return codes;
};

/** What is popular, trending or best-rated, optionally on given services (default: his), by type,
 *  genre, release years and minimum IMDb score. */
export async function popular(opts: { services?: string[]; type?: string; genres?: string[]; sort?: string; year_min?: number; year_max?: number; imdb_min?: number; limit?: number } = {}): Promise<string> {
  const my = await mine();
  const filter: Record<string, unknown> = { objectTypes: types(opts.type), packages: await pkgs(opts.services) };
  if (opts.genres?.length) filter.genres = opts.genres.map((g) => GENRE_CODE[g] || g);
  if (opts.year_min || opts.year_max) filter.releaseYear = { min: opts.year_min, max: opts.year_max };
  if (opts.imdb_min) filter.imdbScore = { min: opts.imdb_min };
  const sortBy = ({ trending: 'TRENDING', popular: 'POPULAR', newest: 'RELEASE_YEAR', random: 'RANDOM' } as any)[opts.sort || 'popular'] || 'POPULAR';
  const d = await gql(`query($n: Int!, $f: TitleFilter, $s: PopularTitlesSorting!) { popularTitles(country: US, first: $n, sortBy: $s, filter: $f) {
    edges { node { id objectType ${CONTENT} ... on Show { totalSeasonCount } ${OFFER} } } } }`,
    { n: Math.max(1, Math.min(50, opts.limit || 20)), f: filter, s: sortBy });
  const rows = d.popularTitles.edges.map((e: any) => [head(e.node), `  ${e.node.content.shortDescription?.slice(0, 220) || ''}`,
    ...where(e.node.offers, my, false).filter((l) => /included|free/.test(l))].join('\n'));
  return rows.length ? rows.join('\n\n') : 'Nothing matches.';
}

/** Titles newly added to services (default: his) over the last `days`. */
export async function added(opts: { services?: string[]; days?: number; type?: string; limit?: number } = {}): Promise<string> {
  const codes = await pkgs(opts.services);
  const out: string[] = [];
  const days = Math.max(1, Math.min(30, opts.days || 7));
  for (let i = 0; i < days && out.length < (opts.limit || 40); i++) {
    const date = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const d = await gql(`query($d: Date!, $f: TitleFilter) { newTitles(country: US, first: 100, date: $d, filter: $f) { edges {
      node { ... on MovieOrShow { id objectType content(${LANG}) { title originalReleaseYear scoring { imdbScore } } }
             ... on Season { id content(${LANG}) { title } show { id content(${LANG}) { title originalReleaseYear scoring { imdbScore } } } } }
      newOffer(platform: WEB) { package { clearName } } } } }`, { d: date, f: { packages: codes, objectTypes: types(opts.type) } });
    for (const e of d.newTitles.edges) {
      const n = e.node, show = n.show;
      const c = show ? show.content : n.content;
      if (!c) continue;
      out.push(`${date} ${show ? show.id : n.id} ${c.title} (${c.originalReleaseYear ?? '?'})${show ? `, ${n.content.title}` : ''}${c.scoring?.imdbScore ? ` | IMDb ${c.scoring.imdbScore}` : ''} | ${e.newOffer?.package?.clearName}`);
    }
  }
  return out.length ? out.slice(0, opts.limit || 40).join('\n') : 'Nothing added in that window.';
}
