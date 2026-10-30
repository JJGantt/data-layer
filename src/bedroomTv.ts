// THE BEDROOM TV — a TCL Google TV, not the wall (the Pi's kiosk TV that set_wall drives).
//
// A command is a tv_commands row (00135). The hub pushes each insert to the TV's companion app
// (google-tv repo, docs/VOICE.md), which does it on the TV and answers by filling `result`. This waits
// for that update on a realtime subscription rather than polling, and gives up after TIMEOUT_MS.
import { randomUUID } from 'crypto';
import { getClient } from './client.js';

export const OPS = ['brightness', 'contrast', 'night', 'volume', 'open', 'launch', 'sidebar', 'overlay', 'now'] as const;
export type Op = (typeof OPS)[number];

// Long enough for a volume walk of many key steps; short enough that a TV that is off answers promptly.
const TIMEOUT_MS = 15_000;

// Apps by the name he says, to their package (installed on the TV, checked 2026-10-30).
export const APPS: Record<string, string> = {
  youtube: 'com.google.android.youtube.tv',
  netflix: 'com.netflix.ninja',
  prime: 'com.amazon.amazonvideo.livingroom',
  disney: 'com.disney.disneyplus',
  hulu: 'com.hulu.livingroomplus',
  max: 'com.wbd.stream',
  tubi: 'com.tubitv',
  appletv: 'com.apple.atve.androidtv.appletv',
  youtubemusic: 'com.google.android.youtube.tvmusic',
  youtubetv: 'com.google.android.youtube.tvunplugged',
};

export async function command(op: Op, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const sb = getClient();
  const id = randomUUID();
  // Subscribed BEFORE the insert, so an answer faster than the subscription cannot be missed.
  const answered = new Promise<Record<string, unknown>>((resolve) => {
    const ch = sb.channel(`tv-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tv_commands', filter: `id=eq.${id}` },
        (p: any) => { if (p.new?.done_at) { sb.removeChannel(ch); resolve(p.new.result || { ok: false }); } })
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        const { error } = await sb.from('tv_commands').insert({ id, op, args });
        if (error) { sb.removeChannel(ch); resolve({ ok: false, error: error.message }); }
      });
    setTimeout(() => { sb.removeChannel(ch); resolve({ ok: false, error: 'no answer from the TV in 15s' }); }, TIMEOUT_MS);
  });
  return answered;
}
