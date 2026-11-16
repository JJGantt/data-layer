import { getClient } from './client.js';

// Where the user is, read on demand by a model that needs it instead of being pasted into every prompt.
//
// Two sources, both fixes the devices took themselves:
// - `location_points` (00139): the phone's and the watch's location history (status-hub docs/LOCATION.md).
//   The phone records in the background all day — visits, a point every few hundred metres of movement,
//   a GPS fix each time — so it is almost always the freshest and most accurate answer.
// - `locations` (00128/00129): the fix a device sent WITH a command, one row per device. It is the only
//   source for the web page, and it moves only when he speaks to a device.
//
// The newest fix is not always the best one: a watch or a phone can hand back a cell-tower position kilometres
// wide moments after a GPS fix a few metres wide. So the answer is every fix that no other fix beats on
// both counts — newer AND tighter — newest first: the newest fix, then each older one only if it is more
// precise than everything after it, stopping at the first GPS-grade fix (GPS_GRADE): metres more precision
// from an older fix is worth less than it being older, while a person is moving. The model judges from age
// and accuracy which one to use.

const GPS_GRADE = 50;  // metres; a cell or Wi-Fi position is hundreds to thousands
const RECENT = 300;  // history rows considered; the walk stops long before this once a GPS fix is reached

interface Fix { device: string; lat: number; lon: number; acc: number | null; at: string; source?: string | null; place?: string | null }

function age(at: string, now: number): string {
  const min = Math.max(0, Math.round((now - new Date(at).getTime()) / 60000));
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Fixes no other fix beats on both age and accuracy, newest first, ending at the first GPS-grade one.
 *  Unknown accuracy never beats a known one. */
export function frontier(fixes: Fix[]): Fix[] {
  const sorted = [...fixes].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  const kept: Fix[] = [];
  let best = Infinity;
  for (const f of sorted) {
    const acc = f.acc ?? Infinity;
    if (best <= GPS_GRADE) break;
    if (kept.length === 0 || acc < best) { kept.push(f); best = Math.min(best, acc); }
  }
  return kept;
}

// Accuracy says how good a fix is; the source adds only what a visit means.
const SOURCE: Record<string, string> = { arrive: 'arrived there', depart: 'left there' };

export function describe(fixes: Fix[], now = Date.now()): string {
  if (!fixes.length) return 'No position recorded yet — none of his devices has sent one.';
  return frontier(fixes).map(r => {
    const fix = `${r.lat.toFixed(5)}, ${r.lon.toFixed(5)}` + (r.acc != null ? ` (within about ${Math.round(r.acc)} m)` : '');
    const how = r.source && SOURCE[r.source] ? `, ${SOURCE[r.source]}` : '';
    return `${r.place ? `${r.place} — ` : ''}${fix}, from the ${r.device}${how}, ${age(r.at, now)}`;
  }).join('\n');
}

export async function lastLocation(): Promise<string> {
  const db = getClient();
  const [hist, cmd] = await Promise.all([
    db.from('location_points').select('device,lat,lon,h_acc,at,source').order('at', { ascending: false }).limit(RECENT),
    db.from('locations').select('device,lat,lon,acc,place,at'),
  ]);
  if (hist.error) throw new Error(hist.error.message);
  if (cmd.error) throw new Error(cmd.error.message);
  const fixes: Fix[] = [
    ...(hist.data ?? []).map((r: any) => ({ device: r.device, lat: r.lat, lon: r.lon, acc: r.h_acc, at: r.at, source: r.source })),
    ...(cmd.data ?? []).map((r: any) => ({ device: r.device, lat: r.lat, lon: r.lon, acc: r.acc, at: r.at, place: r.place })),
  ];
  return describe(fixes);
}
