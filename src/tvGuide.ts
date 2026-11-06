// THE BEDROOM TV'S TV GUIDE — shelves of thumbnails, each item opening a video or show in its app
// (google-tv repo, docs/GUIDE.md). Tables from 00171; the TV reads them through the hub's /api/tv/guide.
//
// Nothing here changes a shelf the caller did not name: every write is scoped to one shelf or to
// named item ids, and `replace` is the only way a shelf's contents go wholesale.
//
// Every write records the whole screen as it stands afterwards in tv_guide_history (00172), so any
// earlier state can be viewed and restored, whole or one shelf of it. A restore is itself a write and
// is recorded too, so it can be undone the same way.
import { randomBytes } from 'crypto';
import { getClient } from './client.js';
import { APPS } from './bedroomTv.js';

export const OPS = ['view', 'show', 'create_shelf', 'rename_shelf', 'move_shelf', 'delete_shelf', 'add', 'remove', 'replace', 'move', 'history', 'history_view', 'restore'] as const;
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

type Shelf = { id: string; title: string; position: number; items: Array<{ id: string; title: string; url: string; package: string | null; image: string | null; position: number }> };

/** The whole screen: every shelf in order with every item. */
async function state(): Promise<Shelf[]> {
  const rows = check(await getClient().from('tv_shelves')
    .select('id,title,position,tv_shelf_items(id,title,url,package,image,position)').order('position')) as any[];
  return rows.map((r) => ({ id: r.id, title: r.title, position: r.position,
    items: [...r.tv_shelf_items].sort((a: any, b: any) => a.position - b.position) }));
}

function format(ss: Shelf[]): string {
  if (!ss.length) return 'The TV Guide has no shelves.';
  const out: string[] = [];
  for (const s of ss) {
    out.push(`${s.id} "${s.title}" (${s.items.length})`);
    s.items.forEach((it, i) => out.push(`  ${i + 1}. ${it.id} ${it.title} [${PACKAGE_NAMES[it.package || ''] || it.package || '?'}] ${it.url}`));
  }
  return out.join('\n');
}

/** Every shelf in screen order with every item, so the caller always sees what is there. */
export async function view(): Promise<string> {
  return format(await state());
}

const when = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Recent changes, newest first: each a version id, when, what changed, and the shelves afterwards. */
async function history(limit = 20): Promise<string> {
  const rows = check(await getClient().from('tv_guide_history').select('id,at,summary,state')
    .order('id', { ascending: false }).limit(Math.max(1, Math.min(200, limit)))) as any[];
  if (!rows.length) return 'No history yet.';
  return rows.map((r) => `v${r.id} ${when(r.at)}: ${r.summary}\n    after: ${(r.state as Shelf[]).map((s) => `"${s.title}" (${s.items.length})`).join(', ') || 'no shelves'}`).join('\n');
}

async function version(v: unknown): Promise<{ id: number; at: string; summary: string; state: Shelf[] }> {
  const id = Number(String(v ?? '').replace(/^v/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new Error('version is a history id, e.g. v12');
  const r = check(await getClient().from('tv_guide_history').select('id,at,summary,state').eq('id', id).maybeSingle()) as any;
  if (!r) throw new Error(`no version v${id}; history lists them`);
  return r;
}

/** Record the screen as it now stands. Exported so a state written outside run() can be captured. */
export async function record(summary: string): Promise<void> {
  check(await getClient().from('tv_guide_history').insert({ summary, state: await state() }));
}

const rows = (shelf: Shelf) => shelf.items.map((it) => ({ ...it, shelf_id: shelf.id }));

/** Put the screen, or one shelf of it, back the way `to` had it, with the same ids. */
async function restore(to: Shelf[], shelfId?: string): Promise<void> {
  const sb = getClient();
  if (!shelfId) {
    check(await sb.from('tv_shelves').delete().neq('id', ''));
    if (to.length) check(await sb.from('tv_shelves').insert(to.map(({ items, ...s }) => s)));
    const all = to.flatMap(rows);
    if (all.length) check(await sb.from('tv_shelf_items').insert(all));
    return;
  }
  const shelf = to.find((s) => s.id === shelfId);
  if (!shelf) throw new Error(`shelf ${shelfId} is not in that version`);
  check(await sb.from('tv_shelves').upsert({ id: shelf.id, title: shelf.title, position: shelf.position }));
  check(await sb.from('tv_shelf_items').delete().eq('shelf_id', shelf.id));
  // An item since moved to another shelf comes back here, so it leaves there.
  if (shelf.items.length) {
    check(await sb.from('tv_shelf_items').delete().in('id', shelf.items.map((i) => i.id)));
    check(await sb.from('tv_shelf_items').insert(rows(shelf)));
  }
}

/** Tell the TV app the shelves changed, so a TV Guide already open redraws. Not awaited for an
 *  answer: a TV that is off or showing something else has nothing to redraw, and the screen reads the
 *  shelves fresh whenever it opens. */
async function refresh(): Promise<void> {
  const { error } = await getClient().from('tv_commands').insert({ op: 'guide_refresh', args: {} });
  if (error) console.error('[tv_guide] refresh', error.message);
}

export async function run(op: Op, a: Record<string, any>): Promise<string> {
  const sb = getClient();
  if (op === 'view') return view();
  if (op === 'history') return history(a.limit ? Number(a.limit) : undefined);
  if (op === 'history_view') {
    const v = await version(a.version);
    return `v${v.id} ${when(v.at)}, after: ${v.summary}\n${format(v.state)}`;
  }
  const before = await state();
  const named = (id: string) => `"${before.find((s) => s.id === id)?.title ?? id}"`;
  let summary = '';
  if (op === 'restore') {
    const v = await version(a.version);
    await restore(v.state, a.shelf || undefined);
    summary = a.shelf ? `restored "${v.state.find((s) => s.id === a.shelf)?.title}" to v${v.id}` : `restored the screen to v${v.id}`;
  } else if (op === 'create_shelf') {
    const title = String(a.title || '').trim();
    if (!title) throw new Error('create_shelf needs a title');
    const id = newId('sh');
    const [position] = positionsAt(await shelves(), 1, a.position);
    check(await sb.from('tv_shelves').insert({ id, title, position }));
    summary = `created "${title}"`;
  } else if (op === 'rename_shelf') {
    const title = String(a.title || '').trim();
    if (!title) throw new Error('rename_shelf needs a title');
    await shelfExists(a.shelf);
    check(await sb.from('tv_shelves').update({ title }).eq('id', a.shelf));
    summary = `renamed ${named(a.shelf)} to "${title}"`;
  } else if (op === 'move_shelf') {
    const others = (await shelves()).filter((s) => s.id !== a.shelf);
    await shelfExists(a.shelf);
    const [position] = positionsAt(others, 1, Number(a.position));
    check(await sb.from('tv_shelves').update({ position }).eq('id', a.shelf));
    summary = `moved ${named(a.shelf)} to position ${a.position}`;
  } else if (op === 'delete_shelf') {
    await shelfExists(a.shelf);
    check(await sb.from('tv_shelves').delete().eq('id', a.shelf));
    summary = `deleted ${named(a.shelf)} and its ${before.find((s) => s.id === a.shelf)?.items.length} items`;
  } else if (op === 'add' || op === 'replace') {
    await shelfExists(a.shelf);
    const resolved = (Array.isArray(a.items) ? a.items : []).map(resolveItem);
    if (!resolved.length && op === 'add') throw new Error('add needs items');
    if (op === 'replace') check(await sb.from('tv_shelf_items').delete().eq('shelf_id', a.shelf));
    const pos = positionsAt(op === 'replace' ? [] : await items(a.shelf), resolved.length, op === 'add' ? a.position : undefined);
    if (resolved.length) check(await sb.from('tv_shelf_items').insert(resolved.map((r: any, i: number) => ({ ...r, id: newId('pk'), shelf_id: a.shelf, position: pos[i] }))));
    summary = op === 'add' ? `added ${resolved.map((r: any) => `"${r.title}"`).join(', ')} to ${named(a.shelf)}`
      : `replaced ${named(a.shelf)} with ${resolved.length} items`;
  } else if (op === 'remove') {
    const ids = (Array.isArray(a.items) ? a.items : []).map(String);
    if (!ids.length) throw new Error('remove needs item ids');
    const gone = check(await sb.from('tv_shelf_items').delete().in('id', ids).select('id')) as Row[];
    const missing = ids.filter((id) => !gone.some((g) => g.id === id));
    const titles = before.flatMap((sh) => sh.items.filter((i) => gone.some((g) => g.id === i.id)).map((i) => `"${i.title}" from "${sh.title}"`));
    // Recorded before refusing, so what was removed is in the history even when some ids were wrong.
    if (gone.length) { await record(`removed ${titles.join(', ')}`); await refresh(); }
    if (missing.length) throw new Error(`removed ${gone.length}; no items ${missing.join(', ')}`);
    return view();
  } else if (op === 'move') {
    const cur = check(await sb.from('tv_shelf_items').select('shelf_id').eq('id', a.item).maybeSingle()) as any;
    if (!cur) throw new Error(`no item ${a.item}`);
    const shelf = a.shelf || cur.shelf_id;
    await shelfExists(shelf);
    const [position] = positionsAt((await items(shelf)).filter((r) => r.id !== a.item), 1, a.position);
    check(await sb.from('tv_shelf_items').update({ shelf_id: shelf, position }).eq('id', a.item));
    const t = before.flatMap((sh) => sh.items).find((i) => i.id === a.item)?.title;
    summary = `moved "${t}" to position ${a.position ?? 'last'} in ${named(shelf)}`;
  }
  await record(summary);
  await refresh();
  return view();
}
