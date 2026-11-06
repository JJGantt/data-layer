// THE BEDROOM TV'S PICKS SCREEN — shelves of thumbnails, each item opening a video or show in its app
// (google-tv repo, docs/PICKS.md). Tables from 00171; the TV reads them through the hub's /api/tv/picks.
//
// Nothing here changes a shelf the caller did not name: every write is scoped to one shelf or to
// named item ids, and `replace` is the only way a shelf's contents go wholesale.
import { randomBytes } from 'crypto';
import { getClient } from './client.js';
import { APPS } from './bedroomTv.js';

export const OPS = ['view', 'show', 'create_shelf', 'rename_shelf', 'move_shelf', 'delete_shelf', 'add', 'remove', 'replace', 'move'] as const;
export type Op = (typeof OPS)[number];

export type ItemIn = { title: string; url: string; image?: string; app?: string };
type Row = { id: string; position: number };

const PACKAGE_NAMES: Record<string, string> = Object.fromEntries(Object.entries(APPS).map(([k, v]) => [v, k]));
const YT = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/)([\w-]{11})/;

/** What opens an item and what its thumbnail is, from its URL: an `intent:` deep link names its own
 *  package; a YouTube URL opens in the YouTube app and has a thumbnail at a fixed address. */
export function resolveItem(it: ItemIn): { title: string; url: string; package: string | null; image: string | null } {
  const title = String(it.title || '').trim();
  const url = String(it.url || '').trim();
  if (!title) throw new Error('every item needs a title');
  if (!url) throw new Error(`"${title}" has no url`);
  let pkg: string | null = it.app ? APPS[it.app] ?? null : null;
  if (it.app && !pkg) throw new Error(`unknown app ${it.app}`);
  const yt = url.match(YT);
  if (!pkg) pkg = url.startsWith('intent:') ? url.match(/;package=([\w.]+)/)?.[1] ?? null : yt ? APPS.youtube : null;
  const image = it.image?.trim() || (yt ? `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg` : null);
  return { title, url, package: pkg, image };
}

/** Positions for `n` new rows placed before the row at 1-based `at` in `rows` (sorted), or after the
 *  last one when `at` is omitted or past the end. Doubles, so neighbours never need renumbering. */
export function positionsAt(rows: Row[], n: number, at?: number): number[] {
  const i = at === undefined ? rows.length : Math.max(0, Math.min(rows.length, Math.floor(at) - 1));
  const lo = i > 0 ? rows[i - 1].position : (rows[0]?.position ?? 1) - 1;
  const hi = i < rows.length ? rows[i].position : lo + n + 1;
  return Array.from({ length: n }, (_, k) => lo + ((hi - lo) * (k + 1)) / (n + 1));
}

const newId = (p: string) => `${p}_${randomBytes(3).toString('hex')}`;

function check<T>(r: { data: T; error: any }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data;
}

async function shelves(): Promise<Array<Row & { title: string }>> {
  return check(await getClient().from('tv_shelves').select('id,title,position').order('position')) as any;
}

async function items(shelf: string): Promise<Array<Row & { title: string; url: string; package: string | null }>> {
  return check(await getClient().from('tv_shelf_items').select('id,title,url,package,position').eq('shelf_id', shelf).order('position')) as any;
}

async function shelfExists(shelf: string): Promise<void> {
  if (!(await shelves()).some((s) => s.id === shelf)) throw new Error(`no shelf ${shelf}; view lists them`);
}

/** Every shelf in screen order with every item, so the caller always sees what is there. */
export async function view(): Promise<string> {
  const ss = await shelves();
  if (!ss.length) return 'The picks screen has no shelves.';
  const out: string[] = [];
  for (const s of ss) {
    const its = await items(s.id);
    out.push(`${s.id} "${s.title}" (${its.length})`);
    its.forEach((it, i) => out.push(`  ${i + 1}. ${it.id} ${it.title} | ${PACKAGE_NAMES[it.package || ''] || it.package || '?'} | ${it.url}`));
  }
  return out.join('\n');
}

/** Tell the TV app the shelves changed, so a picks screen already open redraws. Not awaited for an
 *  answer: a TV that is off or showing something else has nothing to redraw, and the screen reads the
 *  shelves fresh whenever it opens. */
async function refresh(): Promise<void> {
  const { error } = await getClient().from('tv_commands').insert({ op: 'picks_refresh', args: {} });
  if (error) console.error('[tv_picks] refresh', error.message);
}

export async function run(op: Op, a: Record<string, any>): Promise<string> {
  const sb = getClient();
  if (op === 'view') return view();
  if (op === 'create_shelf') {
    const title = String(a.title || '').trim();
    if (!title) throw new Error('create_shelf needs a title');
    const id = newId('sh');
    const [position] = positionsAt(await shelves(), 1, a.position);
    check(await sb.from('tv_shelves').insert({ id, title, position }));
  } else if (op === 'rename_shelf') {
    const title = String(a.title || '').trim();
    if (!title) throw new Error('rename_shelf needs a title');
    await shelfExists(a.shelf);
    check(await sb.from('tv_shelves').update({ title }).eq('id', a.shelf));
  } else if (op === 'move_shelf') {
    const others = (await shelves()).filter((s) => s.id !== a.shelf);
    await shelfExists(a.shelf);
    const [position] = positionsAt(others, 1, Number(a.position));
    check(await sb.from('tv_shelves').update({ position }).eq('id', a.shelf));
  } else if (op === 'delete_shelf') {
    await shelfExists(a.shelf);
    check(await sb.from('tv_shelves').delete().eq('id', a.shelf));
  } else if (op === 'add' || op === 'replace') {
    await shelfExists(a.shelf);
    const resolved = (Array.isArray(a.items) ? a.items : []).map(resolveItem);
    if (!resolved.length && op === 'add') throw new Error('add needs items');
    if (op === 'replace') check(await sb.from('tv_shelf_items').delete().eq('shelf_id', a.shelf));
    const pos = positionsAt(op === 'replace' ? [] : await items(a.shelf), resolved.length, op === 'add' ? a.position : undefined);
    if (resolved.length) check(await sb.from('tv_shelf_items').insert(resolved.map((r: any, i: number) => ({ ...r, id: newId('pk'), shelf_id: a.shelf, position: pos[i] }))));
  } else if (op === 'remove') {
    const ids = (Array.isArray(a.items) ? a.items : []).map(String);
    if (!ids.length) throw new Error('remove needs item ids');
    const gone = check(await sb.from('tv_shelf_items').delete().in('id', ids).select('id')) as Row[];
    const missing = ids.filter((id) => !gone.some((g) => g.id === id));
    if (missing.length) throw new Error(`removed ${gone.length}; no items ${missing.join(', ')}`);
  } else if (op === 'move') {
    const cur = check(await sb.from('tv_shelf_items').select('shelf_id').eq('id', a.item).maybeSingle()) as any;
    if (!cur) throw new Error(`no item ${a.item}`);
    const shelf = a.shelf || cur.shelf_id;
    await shelfExists(shelf);
    const [position] = positionsAt((await items(shelf)).filter((r) => r.id !== a.item), 1, a.position);
    check(await sb.from('tv_shelf_items').update({ shelf_id: shelf, position }).eq('id', a.item));
  }
  if (op !== 'show') await refresh();
  return view();
}
