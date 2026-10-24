import { getClient } from './client.js';

// Where Jared last was, from `locations` (00128): one row per device, upserted by the hub from the
// fix a device sends with a command. Read on demand by a model that needs it, instead of being pasted
// into every prompt.
//
// The row only moves when he speaks to a device that has a fix, so a position can be hours old. Every
// line says how old it is and from which device, and the model judges whether it is still good enough.

function age(at: string): string {
  const min = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  if (min < 1) return 'just now';
  if (min < 90) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Every device's last position, newest first. */
export async function lastLocation(): Promise<string> {
  const { data, error } = await getClient().from('locations')
    .select('device,lat,lon,acc,place,at').order('at', { ascending: false });
  if (error) throw new Error(error.message);
  if (!data?.length) return 'No position recorded yet — none of his devices has sent one.';
  return data.map((r: any) => {
    const fix = `${r.lat}, ${r.lon}` + (r.acc != null ? ` (within about ${r.acc} m)` : '');
    return `${r.place ? `${r.place} — ` : ''}${fix}, from the ${r.device}, ${age(r.at)}`;
  }).join('\n');
}
