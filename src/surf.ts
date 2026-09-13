import { getClient } from './client.js';

// Surf at the break Jared follows, from surf-report's mirror of Surfline: `surf_hours` (one row per
// spot-hour, rebuilt every few hours by the Pi's collector) and `water_readings`. Surfline blocks bots,
// so this is the only way a model gets it — web search does not reach the forecast.
//
// Units are the ones Surfline reports for these captures (checked against the endpoints'
// `associated.units`): feet for surf and swell, knots for wind, Fahrenheit for air and water.
//
// Times are the spot's own clock. The break is in Florida wherever the machine answering happens to be.
const SPOT_TZ = 'America/New_York';

const hourFmt = new Intl.DateTimeFormat('en-US', { timeZone: SPOT_TZ, weekday: 'short', hour: 'numeric' });
const stampFmt = new Intl.DateTimeFormat('en-US', { timeZone: SPOT_TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number | null) => (deg == null ? '?' : COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]);

function line(h: any): string {
  const size = h.s_min == null ? '?' : (h.s_min === h.s_max ? `${h.s_min}` : `${h.s_min}-${h.s_max}`) + (h.s_plus ? '+' : '');
  const rating = h.rk ? String(h.rk).toLowerCase().replace(/_/g, ' ') : 'unrated';
  const wind = h.w_spd == null ? 'wind ?' : `wind ${Math.round(h.w_spd)} kt ${compass(h.w_dir)}${h.w_type ? ` (${String(h.w_type).toLowerCase()})` : ''}`;
  const swell = h.sw_h == null ? '' : `, swell ${Number(h.sw_h).toFixed(1)} ft @ ${h.sw_p}s from ${compass(h.sw_d)}`;
  return `${hourFmt.format(new Date(h.ts * 1000))}: ${rating}, ${size} ft, ${wind}${swell}`;
}

/** The next `days` of forecast at three-hour steps, with when it was captured and the water temperature. */
export async function surfReport(days = 2): Promise<string> {
  const span = Math.max(1, Math.min(10, Math.round(days) || 2));
  const nowS = Math.floor(Date.now() / 1000);
  const { data: hours, error } = await getClient().from('surf_hours')
    .select('slug,ts,rk,s_min,s_max,s_plus,w_spd,w_dir,w_type,sw_h,sw_p,sw_d,source_captured_at')
    .gte('ts', nowS - 3600).lte('ts', nowS + span * 86400).order('ts');
  if (error) throw new Error(error.message);
  if (!hours?.length) return 'No forecast in surf_hours covers the coming hours — the collector may have stopped.';

  const captured = hours.reduce((a: string, h: any) => (h.source_captured_at > a ? h.source_captured_at : a), '');
  const steps = hours.filter((h: any) => (h.ts - hours[0].ts) % (3 * 3600) === 0);
  const { data: water } = await getClient().from('water_readings')
    .select('ts,water_f,station').lte('ts', new Date().toISOString()).order('ts', { ascending: false }).limit(1);
  const w = water?.[0];

  return [
    `${hours[0].slug} — Surfline forecast captured ${stampFmt.format(new Date(captured))}. Times ET; surf and swell in feet, wind in knots.`,
    ...steps.map(line),
    ...(w ? [`Water ${w.water_f}°F (${w.station}, ${stampFmt.format(new Date(w.ts))}).`] : []),
  ].join('\n');
}
