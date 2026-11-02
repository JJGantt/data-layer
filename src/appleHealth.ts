import { getClient } from './client.js';
import { today } from './helpers.js';

// Apple Health, as the StatusHub iPhone app mirrors it into `health_samples` and `sleep_samples`
// (migrations 00134/00136, rolled up by 00137; status-hub docs/HEALTH.md). Read-only: nothing here
// writes, because Health on the phone is the record and this is a copy of it.

const TZ = 'America/New_York';

function addDays(d: string, n: number): string {
  const t = new Date(`${d}T12:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

// The UTC instant of midnight in New York starting date `d`, whichever side of a DST change it is on.
// Read from the zone's own offset at that date, so it does not depend on the process's timezone.
function nyMidnight(d: string): string {
  const probe = new Date(`${d}T12:00:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  return new Date(`${d}T00:00:00${off.replace('GMT', '') || 'Z'}`).toISOString();
}

const r1 = (v: number | null | undefined) => (v == null ? '' : String(Math.round(v * 10) / 10));
const hm = (min: number) => `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const stamp = (iso: string) => new Date(iso).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);

/** Every type that has data, with its unit, count and span. */
export async function catalogue(): Promise<string> {
  const { data, error } = await getClient().rpc('health_types');
  if (error) throw new Error(error.message);
  const rows = (data || []) as { type: string; unit: string | null; samples: number; first_at: string; last_at: string }[];
  const { count: sleep } = await getClient().from('sleep_samples').select('id', { count: 'exact', head: true });
  if (!rows.length && !sleep) return 'No Apple Health data has arrived yet.';
  const lines = rows.map((r) => `${r.type}\t${r.unit ?? '(category)'}\t${r.samples}\t${stamp(r.first_at).slice(0, 10)} → ${stamp(r.last_at)}`);
  if (sleep) lines.unshift(`sleep\t(stages)\t${sleep}\tuse type "sleep"`);
  return `type\tunit\tsamples\tspan\n${lines.join('\n')}`;
}

/** Nights, keyed by the wake date. */
export async function sleep(from: string, to: string): Promise<string> {
  const { data, error } = await getClient().rpc('sleep_nights', { p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  const rows = (data || []) as { night: string; bed_at: string; up_at: string; asleep_min: number; core_min: number;
    deep_min: number; rem_min: number; awake_min: number }[];
  if (!rows.length) return `No sleep recorded ${from} to ${to}.`;
  return 'woke\tbed → up\tasleep\tcore\tdeep\trem\tawake\n' + rows.map((r) =>
    `${r.night}\t${clock(r.bed_at)} → ${clock(r.up_at)}\t${hm(r.asleep_min)}\t${hm(r.core_min)}\t${hm(r.deep_min)}\t${hm(r.rem_min)}\t${Math.round(r.awake_min)}m`).join('\n');
}

/** One type rolled up per calendar day. */
export async function daily(type: string, from: string, to: string): Promise<string> {
  const { data, error } = await getClient().rpc('health_daily', { p_type: type, p_from: from, p_to: to });
  if (error) throw new Error(error.message);
  const rows = (data || []) as { day: string; samples: number; avg: number; min: number; max: number; sum: number; unit: string | null }[];
  if (!rows.length) return `No ${type} recorded ${from} to ${to}. get_health_data with no type lists what exists.`;
  const unit = rows.find((r) => r.unit)?.unit ?? 'category value';
  return `${type} (${unit}), per day\nday\tsamples\tavg\tmin\tmax\tsum\n` + rows.map((r) =>
    `${r.day}\t${r.samples}\t${r1(r.avg)}\t${r1(r.min)}\t${r1(r.max)}\t${r1(r.sum)}`).join('\n');
}

/** Individual readings in a window — heart rate across a workout, every HRV reading this week. */
export async function samples(type: string, from: string, to: string, limit: number): Promise<string> {
  const { data, error } = await getClient().from('health_samples')
    .select('start_at, end_at, value, unit, label, source, metadata')
    .eq('type', type)
    .gte('start_at', nyMidnight(from))
    .lt('start_at', nyMidnight(addDays(to, 1)))
    .order('start_at').limit(limit);
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!rows.length) return `No ${type} readings ${from} to ${to}.`;
  const head = rows.length === limit ? `First ${limit} readings — narrow the window for the rest.\n` : '';
  if (type === 'workout') {
    return head + 'start\tend\tactivity\tminutes\tstats\n' + rows.map((r) =>
      `${stamp(r.start_at)}\t${clock(r.end_at)}\t${r.label}\t${Math.round((r.value ?? 0) / 60)}\t${JSON.stringify((r.metadata as any)?.stats ?? {})}`).join('\n');
  }
  return head + `${type} (${rows[0].unit ?? 'category value'})\nstart\tvalue\tsource\n` +
    rows.map((r) => `${stamp(r.start_at)}\t${r1(r.value)}\t${r.source ?? ''}`).join('\n');
}

export async function getHealthData(a: { type?: string; from?: string; to?: string; readings?: boolean; limit?: number }): Promise<string> {
  const to = a.to || today();
  const from = a.from || addDays(to, -6);
  if (!a.type) return catalogue();
  if (a.type === 'sleep') return sleep(from, to);
  if (a.readings || a.type === 'workout') return samples(a.type, from, to, Math.min(a.limit || 500, 2000));
  return daily(a.type, from, to);
}
