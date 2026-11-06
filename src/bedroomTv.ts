// THE BEDROOM TV — a TCL Google TV, not the wall (the Pi's kiosk TV that set_wall drives).
//
// A command is a tv_commands row (00135). The hub pushes each insert to the TV's companion app
// (google-tv repo, docs/VOICE.md), which does it on the TV and answers by filling `result`. This waits
// for that update on a realtime subscription rather than polling, and gives up after TIMEOUT_MS.
import { randomUUID } from 'crypto';
import { getClient } from './client.js';

export const OPS = ['power', 'brightness', 'contrast', 'night', 'volume', 'open', 'launch', 'sidebar', 'overlay', 'now', 'media', 'key', 'input', 'sleep'] as const;
export type Op = (typeof OPS)[number];

// Long enough for a volume walk of many key steps. An op that may wake the TV first gets longer: the
// Pi's Wake-on-LAN, the screen coming on and the app reconnecting (google-tv docs/POWER.md).
const TIMEOUT_MS = 15_000;
const WAKE_TIMEOUT_MS = 45_000;
const WAKES = new Set<Op>(['power', 'open', 'launch', 'input']);

// Apps by their spoken name, to their package (installed on the TV, checked 2026-10-30).
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
  // The TV Guide, in the TV's own companion app (google-tv docs/GUIDE.md; tvGuide.ts).
  guide: 'com.jaredgantt.tvcompanion',
};

// `media` actions, done on whatever is playing through its media session (google-tv TvLink).
export const MEDIA_ACTIONS = ['play', 'pause', 'toggle', 'stop', 'next', 'previous', 'forward', 'back', 'seek'] as const;
// Remote buttons, pressed by the Pi over adb (tvHome.ts): an app on the TV cannot inject keys.
export const KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', select: 'KEYCODE_DPAD_CENTER',
};

// A level setter reads the level first and answers with it as `before`, so "what was it before?" and
// "put it back" have an answer however long after the change it is asked. The TV reports only the value
// after a set, and nothing else keeps the old one.
const LEVELS = new Set<Op>(['volume', 'brightness', 'contrast']);

export async function command(op: Op, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!LEVELS.has(op) || args.value === undefined) return send(op, args);
  const read = await send(op, {});
  const after = await send(op, args);
  return read.ok && read[op] !== undefined ? { ...after, before: read[op] } : after;
}

async function send(op: Op, args: Record<string, unknown>): Promise<Record<string, unknown>> {
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
    const ms = WAKES.has(op) ? WAKE_TIMEOUT_MS : TIMEOUT_MS;
    setTimeout(() => { sb.removeChannel(ch); resolve({ ok: false, error: `no answer from the TV in ${ms / 1000}s` }); }, ms);
  });
  return answered;
}

/** What the sidebar's content view shows (the hub's tv_sidebar_content setting). */
export async function sidebarContent(): Promise<string> {
  const { data, error } = await getClient().from('app_settings').select('value').eq('key', 'tv_sidebar_content').maybeSingle();
  if (error) throw new Error(error.message);
  return String(data?.value ?? '');
}
