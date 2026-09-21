import { getClient } from './client.js';
import { now } from './helpers.js';

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
    ...(await surfAlarmLines()),
  ].join('\n');
}

// ---- the surf alarm (00111) ----------------------------------------------------------------------
// This side only stores the conditions. The hub applies them: it hears every new forecast over
// realtime, decides, and owns the alarm item that results (status-hub server/lib/surfalarm.js). The
// matching is written once, there, so there is no second copy here to disagree with it.

export type SurfRule = { hours: number[]; wake: string };
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function ruleText(r: SurfRule): string {
  return r.hours.length ? `fair at ${r.hours.join(', ')} -> ${r.wake}` : `otherwise -> ${r.wake}`;
}

function decisionText(a: any): string {
  const d = a.decided;
  if (!a.engaged) return 'disengaged';
  if (!d) return 'the hub has not decided yet';
  if (d.late) return `matched rule ${d.rule + 1} (${d.at.slice(11)}), but that time had already passed, so it was left alone`;
  if (d.rule == null) return 'no rule matches the current forecast, so no alarm is set';
  return `rings at ${String(d.at).slice(11)} (rule ${d.rule + 1} matches the current forecast)`;
}

function checkDay(day: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || '').trim());
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCDate() !== +m[3]) throw new Error(`day must be YYYY-MM-DD, got '${day}'`);
  return m[0];
}

function checkRules(rules: unknown): SurfRule[] {
  if (!Array.isArray(rules) || !rules.length) throw new Error('rules must be a non-empty list of {hours, wake}');
  const out = rules.map((r: any, i: number) => {
    const hours = Array.isArray(r?.hours) ? r.hours.map(Number) : null;
    if (!hours || hours.some((h: number) => !Number.isInteger(h) || h < 0 || h > 23)) {
      throw new Error(`rule ${i + 1}: hours must be whole hours 0-23`);
    }
    const wake = String(r?.wake ?? '').trim();
    if (!HHMM.test(wake)) throw new Error(`rule ${i + 1}: wake must be HH:MM, got '${r?.wake}'`);
    return { hours: [...new Set<number>(hours)].sort((a, b) => a - b), wake };
  });
  // Every rule after an unconditional one is unreachable, which is a mistake rather than a wish.
  const open = out.findIndex(r => !r.hours.length);
  if (open >= 0 && open < out.length - 1) throw new Error('a rule with no hours matches always, so it must be the last one');
  return out;
}

/**
 * Engage the surf alarm for one morning with ordered rules, or disengage it. Rules replace whatever
 * was there. Waits briefly for the hub's decision so the answer can say what will actually ring.
 */
export async function setSurfAlarm(dayIn: string, rulesIn: unknown, engaged: boolean): Promise<string> {
  const sb = getClient();
  const day = checkDay(dayIn);
  const { data: existing } = await sb.from('surf_alarms').select('*').eq('day', day).maybeSingle();
  const stamp = now();
  if (!engaged) {
    if (!existing) return `No surf alarm is set for ${day}.`;
    await sb.from('surf_alarms').update({ engaged: false, updated: stamp }).eq('day', day);
    return `Surf alarm for ${day} disengaged. The hub removes its alarm within seconds, unless it has already gone off.`;
  }
  const rules = checkRules(rulesIn);
  // `state` belongs to the hub, which holds the alarm item there. The one thing done to it here: an
  // item he deleted or completed is forgotten, because the hub never puts one of those back and
  // re-engaging means he wants a fresh one.
  const state = { ...(existing?.state ?? {}) };
  if (state.item?.id) {
    const { data: it } = await sb.from('list_items').select('deleted,completed_at').eq('id', state.item.id).maybeSingle();
    if (!it || it.deleted || it.completed_at) delete state.item;
  }
  if (existing) await sb.from('surf_alarms').update({ rules, engaged: true, state, updated: stamp }).eq('day', day);
  else await sb.from('surf_alarms').insert({ day, rules, engaged: true, created: stamp, updated: stamp });

  // The hub hears the write over realtime and decides within a second or two. If the decision is
  // unchanged it writes nothing, so a quiet row after the wait means "same answer", not "no answer".
  let row: any = null;
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 500));
    ({ data: row } = await sb.from('surf_alarms').select('*').eq('day', day).maybeSingle());
    if (row?.decided && String(row.updated) > stamp) break;
  }
  return [`Surf alarm for ${day}:`, ...rules.map((r, i) => `${i + 1}. ${ruleText(r)}`), `Now: ${decisionText(row)}.`].join('\n');
}

async function surfAlarmLines(): Promise<string[]> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: SPOT_TZ }).format(new Date());
  const { data } = await getClient().from('surf_alarms').select('*').gte('day', today).eq('engaged', true).order('day');
  return (data ?? []).map((a: any) =>
    `Surf alarm ${a.day}: ${(a.rules as SurfRule[]).map(ruleText).join('; ')}. Now: ${decisionText(a)}.`);
}
