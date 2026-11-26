import { getClient } from './client.js';
import { ValidationError } from './helpers.js';
import { placesFor, placeKey, placeText, type Place } from './places.js';

// Where the user is, and where he was, read on demand by a model that needs it instead of being pasted
// into every prompt.
//
// Two sources, both fixes the devices took themselves:
// - `location_points` (00139): the phone's and the watch's location history (status-hub docs/LOCATION.md).
//   The phone records in the background — arriving and leaving a place, a point every few hundred metres
//   of movement, a GPS fix each time — so it is almost always the freshest and most accurate answer.
// - `locations` (00128/00129): the fix a device sent WITH a command, one row per device. It is the only
//   source for the web page, and it moves only when he speaks to a device.
//
// NOW: the newest fix is not always the best one: a watch or a phone can hand back a cell-tower position
// kilometres wide moments after a GPS fix a few metres wide. So the answer is every fix that no other fix
// beats on both counts — newer AND tighter — newest first, stopping at the first GPS-grade fix: metres more
// precision from an older fix is worth less than it being older, while a person is moving.
//
// THE PAST (`at`, or `from` + `to`): the history over the window as a timeline of STAYS (a run of fixes
// within STAY_M of where the run began, lasting at least STAY_MIN, start to end) and the fixes BETWEEN them (a trip), with any stretch
// that has no fix at all stated as a gap. A coarse fix is dropped wherever a GPS-grade one exists within
// COARSE_NEAR of it, because it says the same thing worse. While he sits still the phone sends nothing, so
// a gap between two fixes at the same place is a stay, not missing data: the stay runs across it.

const TZ = 'America/New_York';
const GPS_GRADE = 50;          // metres; a cell or Wi-Fi position is hundreds to thousands
const STAY_M = 150;            // metres from a stay's first fix that still count as the same place
const STAY_MIN = 5 * 60e3;    // a run shorter than this is a pause on a trip, not a stay
const COARSE_NEAR = 15 * 60e3; // a coarse fix this close in time to a GPS-grade one adds nothing
const AT_SPAN = 3 * 3600e3;    // `at` alone reads this much either side of it
const NOW_ROWS = 300;          // history rows considered for "now"; the walk stops long before this

export interface Fix { device: string; lat: number; lon: number; acc: number | null; at: string; source?: string | null; place?: string | null }

function age(at: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(at).getTime()) / 60000));
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const clock = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const ms = (f: Fix) => new Date(f.at).getTime();

/** Metres between two fixes (haversine). */
export function distance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371e3 * Math.asin(Math.sqrt(h));
}

/** A local wall-clock reading in New York ('YYYY-MM-DDTHH:MM', seconds optional) as an instant. */
export function nyInstant(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s.trim());
  if (!m) throw new ValidationError(`time must be local wall clock YYYY-MM-DDTHH:MM, got "${s}"`);
  const [, y, mo, d, h, mi, se] = m.map(Number) as number[];
  const wall = Date.UTC(y, mo - 1, d, h, mi, se || 0);
  const chk = new Date(wall);
  if (chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== d || chk.getUTCHours() !== h) throw new ValidationError(`no such time: "${s}"`);
  // The zone's offset at that wall time, read from the zone itself so the host's own timezone is irrelevant.
  const offAt = (t: number) => {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
      .formatToParts(new Date(t)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
    const o = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
    return o ? (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3])) * 60e3 : 0;
  };
  const guess = wall - offAt(wall);
  return wall - offAt(guess);
}

/** Fixes no other fix beats on both age and accuracy, newest first, ending at the first GPS-grade one.
 *  Unknown accuracy never beats a known one. */
export function frontier(fixes: Fix[]): Fix[] {
  const sorted = [...fixes].sort((a, b) => ms(b) - ms(a));
  const kept: Fix[] = [];
  let best = Infinity;
  for (const f of sorted) {
    if (best <= GPS_GRADE) break;
    const acc = f.acc ?? Infinity;
    if (kept.length === 0 || acc < best) { kept.push(f); best = Math.min(best, acc); }
  }
  return kept;
}

// Accuracy says how good a fix is; the source adds only what a visit means.
const SOURCE: Record<string, string> = { arrive: 'arrived there', depart: 'left there' };

type Names = Map<string, Place> | null;
/** A position as words when Apple named it, its coordinates (for the model, never to be read out) either way. */
const where = (lat: number, lon: number, acc: number | null, names: Names, own?: string | null) => {
  const name = own || placeText(names?.get(placeKey(lat, lon)));
  const c = `${lat.toFixed(5)}, ${lon.toFixed(5)}${acc != null ? `, within ${Math.round(acc)} m` : ''}`;
  return name ? `${name} (${c})` : c;
};

export function describe(fixes: Fix[], now = Date.now(), names: Names = null): string {
  if (!fixes.length) return 'No position recorded yet — none of his devices has sent one.';
  return frontier(fixes).map(r => {
    const how = r.source && SOURCE[r.source] ? `, ${SOURCE[r.source]}` : '';
    return `${where(r.lat, r.lon, r.acc, names, r.place)}, from the ${r.device}${how}, ${age(r.at, now)}`;
  }).join('\n');
}

export type Segment =
  | { kind: 'stay'; from: number; to: number; lat: number; lon: number; acc: number; fixes: number }
  | { kind: 'fix'; at: number; fix: Fix };

/** The window's fixes as stays and the fixes between them, oldest first. */
export function timeline(fixes: Fix[]): Segment[] {
  const sorted = [...fixes].sort((a, b) => ms(a) - ms(b));
  const precise = sorted.filter((f) => f.acc != null && f.acc <= GPS_GRADE).map(ms);
  // A visit (arrive / depart) is kept whatever its accuracy: its TIME is the point of it.
  const isVisit = (f: Fix) => f.source === 'arrive' || f.source === 'depart';
  const useful = sorted.filter((f) => isVisit(f) || (f.acc != null && f.acc <= GPS_GRADE)
    || !precise.some((t) => Math.abs(t - ms(f)) <= COARSE_NEAR))
    // The phone stores a wake's position and its GPS fix at the same instant; one line says it.
    .filter((f, i, all) => i === 0 || isVisit(f) || ms(f) - ms(all[i - 1]) > 5000 || distance(f, all[i - 1]) > 1);
  const out: Segment[] = [];
  let run: Fix[] = [];
  const flush = () => {
    if (!run.length) return;
    if (ms(run[run.length - 1]) - ms(run[0]) < STAY_MIN) run.forEach((f) => out.push({ kind: 'fix', at: ms(f), fix: f }));
    else {
      const best = run.reduce((a, b) => ((b.acc ?? Infinity) < (a.acc ?? Infinity) ? b : a));
      out.push({ kind: 'stay', from: ms(run[0]), to: ms(run[run.length - 1]), lat: best.lat, lon: best.lon,
        acc: Math.round(best.acc ?? 0), fixes: run.length });
    }
    run = [];
  };
  for (const f of useful) {
    if (run.length && distance(run[0], f) > Math.max(STAY_M, f.acc ?? 0)) flush();
    // A fix that leaves a place starts the trip; a depart row is the stay's own end.
    run.push(f);
    if (f.source === 'depart') flush();
  }
  flush();
  return out;
}

function renderTimeline(segs: Segment[], from: number, to: number, at?: number, names: Names = null): string {
  if (!segs.length) return `No fix at all between ${clock(from)} and ${clock(to)}.`;
  const lines: string[] = [];
  const first = segs[0].kind === 'stay' ? segs[0].from : segs[0].at;
  if (first - from > 30 * 60e3) lines.push(`(no fix from ${clock(from)} until ${clock(first)})`);
  for (const s of segs) {
    if (s.kind === 'stay') {
      lines.push(`${clock(s.from)} – ${clock(s.to)}: stayed at ${where(s.lat, s.lon, s.acc, names)}`);
    } else {
      const f = s.fix, how = f.source && SOURCE[f.source] ? `, ${SOURCE[f.source]}` : '';
      lines.push(`${clock(s.at)}: ${where(f.lat, f.lon, f.acc, names)}, ${f.device}${how}`);
    }
  }
  const last = segs[segs.length - 1], end = last.kind === 'stay' ? last.to : last.at;
  if (to - end > 30 * 60e3) lines.push(`(no fix after ${clock(end)} until ${clock(to)})`);
  if (at != null) {
    const holding = segs.find((s) => s.kind === 'stay' && s.from <= at && at <= s.to);
    const before = [...segs].reverse().find((s) => (s.kind === 'stay' ? s.to : s.at) <= at);
    const after = segs.find((s) => (s.kind === 'stay' ? s.from : s.at) >= at);
    const head = holding ? `At ${clock(at)}: inside a stay (below).`
      : `At ${clock(at)}: no fix at that moment; the nearest are ${before ? `before at ${clock(before.kind === 'stay' ? before.to : before.at)}` : 'none before'} and ${after ? `after at ${clock(after.kind === 'stay' ? after.from : after.at)}` : 'none after'}. If both are the same place he very likely stayed there: the phone sends nothing while he sits still.`;
    lines.unshift(head);
  }
  return lines.join('\n');
}

export interface LocationQuery { at?: string; from?: string; to?: string }

export async function location(q: LocationQuery = {}): Promise<string> {
  if (!q.at && !q.from && !q.to) return lastLocation();
  let from: number, to: number, at: number | undefined;
  if (q.at) {
    if (q.from || q.to) throw new ValidationError('give either `at` or `from` + `to`, not both');
    at = nyInstant(q.at); from = at - AT_SPAN; to = at + AT_SPAN;
  } else {
    if (!q.from || !q.to) throw new ValidationError('a range needs both `from` and `to`');
    from = nyInstant(q.from); to = nyInstant(q.to);
    if (to <= from) throw new ValidationError('`to` must be after `from`');
  }
  const rows: Fix[] = [];
  for (let page = 0; ; page++) {
    const { data, error } = await getClient().from('location_points').select('device,lat,lon,h_acc,at,source')
      .gte('at', new Date(from).toISOString()).lte('at', new Date(to).toISOString())
      .order('at', { ascending: true }).range(page * 1000, page * 1000 + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []).map((r: any) => ({ device: r.device, lat: r.lat, lon: r.lon, acc: r.h_acc, at: r.at, source: r.source })));
    if (!data || data.length < 1000) break;
  }
  const segs = timeline(rows);
  const names = await placesFor(segs.map((g) => (g.kind === 'stay' ? g : g.fix)));
  return renderTimeline(segs, from, to, at, names) + (names ? '' : '\n(No place names: Apple Maps could not be reached; only coordinates.)');
}

async function nowFixes(): Promise<Fix[]> {
  const db = getClient();
  const [hist, cmd] = await Promise.all([
    db.from('location_points').select('device,lat,lon,h_acc,at,source').order('at', { ascending: false }).limit(NOW_ROWS),
    db.from('locations').select('device,lat,lon,acc,place,at'),
  ]);
  if (hist.error) throw new Error(hist.error.message);
  if (cmd.error) throw new Error(cmd.error.message);
  return [
    ...(hist.data ?? []).map((r: any) => ({ device: r.device, lat: r.lat, lon: r.lon, acc: r.h_acc, at: r.at, source: r.source })),
    ...(cmd.data ?? []).map((r: any) => ({ device: r.device, lat: r.lat, lon: r.lon, acc: r.acc, at: r.at, place: r.place })),
  ];
}

export async function lastLocation(): Promise<string> {
  const fixes = await nowFixes();
  const names = await placesFor(frontier(fixes));
  return describe(fixes, Date.now(), names) + (names ? '' : '\n(No place names: Apple Maps could not be reached; only coordinates.)');
}

/** The one fix that best says where he was at `at` (an instant; omitted = now), or null when none is
 *  near enough. The last fix at or before the moment wins — the phone sends nothing while he sits still,
 *  so the last fix before is where he stayed — except that a GPS-grade fix close to it beats a coarse
 *  one. With nothing before, the first fix within an hour after. Used by the pantry's home check. */
export async function fixAt(at?: number): Promise<Fix | null> {
  if (at == null) {
    const fixes = await nowFixes();
    const f = frontier(fixes);
    return f.length ? f[f.length - 1] : null;
  }
  const { data, error } = await getClient().from('location_points').select('device,lat,lon,h_acc,at,source')
    .gte('at', new Date(at - 12 * 3600e3).toISOString()).lte('at', new Date(at + 3600e3).toISOString())
    .order('at', { ascending: true });
  if (error) throw new Error(error.message);
  const rows: Fix[] = (data ?? []).map((r: any) => ({ device: r.device, lat: r.lat, lon: r.lon, acc: r.h_acc, at: r.at, source: r.source }));
  return pickFixAt(rows, at);
}

/** The choice fixAt makes, over fixes already read. */
export function pickFixAt(rows: Fix[], at: number): Fix | null {
  const before = rows.filter((f) => ms(f) <= at).sort((a, b) => ms(b) - ms(a));
  if (before.length) {
    const last = before[0];
    if ((last.acc ?? Infinity) <= GPS_GRADE) return last;
    const precise = before.find((f) => (f.acc ?? Infinity) <= GPS_GRADE && ms(last) - ms(f) <= COARSE_NEAR);
    return precise ?? last;
  }
  return rows.find((f) => ms(f) > at) ?? null;
}
