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
const WAKES = new Set<string>(['power', 'open', 'launch', 'input']);
// The Pi's `check`: Apple TV's title page and its Play, then sound starting.
const CHECK_TIMEOUT_MS = 40_000;

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

// `media` actions, done on whatever is playing through its media session (google-tv TvLink). Only play
// and pause: a skip is a seek from the session's position, which is its app's claim extrapolated, and
// an app that says it is playing when it is not (Apple TV) makes that a jump to nowhere.
export const MEDIA_ACTIONS = ['play', 'pause'] as const;
// Remote buttons, pressed by the Pi over adb (tvHome.ts): an app on the TV cannot inject keys.
export const KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', select: 'KEYCODE_DPAD_CENTER',
};

// A level setter reads the level first and answers with it as `before`, so "what was it before?" and
// "put it back" have an answer however long after the change it is asked. The TV reports only the value
// after a set, and nothing else keeps the old one.
const LEVELS = new Set<Op>(['volume', 'brightness', 'contrast']);

// Every playback answer is checked on the TV itself by the Pi (tvHome.ts), because an app's media
// session reports only what the app claims: Apple TV's says PLAYING over its title page's trailer and
// over a stopped film. The app answers `now`, `media` and `open`; the Pi says whether that app is
// actually sending sound, and whether Apple TV is sitting on a title page. An `open` is followed up by
// the Pi whoever wrote it (the phone's TV Guide too), so the tool waits for that row's `outcome`.
const APPLE = /com\.apple\.atve\.androidtv\.appletv|tv\.apple\.com/;

/** The app's answer `r`, corrected by the Pi's look at the TV `c` (tvHome.ts inspect). */
export function judge(r: Record<string, any>, c: Record<string, any>): Record<string, any> {
  if (!r.ok) return r;
  if (!c.ok) return { ...r, verified: false, verify_error: c.error };
  const out: Record<string, any> = { ...r, playing: !!c.playing };
  if (c.foreground) out.foreground = c.foreground;
  if (c.profile) out.profile = c.profile;
  if (c.pressed) out.pressed = c.pressed;
  if (c.title_page) {
    out.state = 'title page';
    out.button = c.button;
    delete out.position_s;
    out.ok = false;
    out.error = c.sells
      ? `not playing: Apple TV is on the title page, whose button is "${c.button}", which sells something, so it was not pressed`
      : c.pressed ? `not playing: pressed "${c.pressed}" and the title page is still there`
      : `not playing: Apple TV is on the title page, whose button is "${c.button}"`;
    return out;
  }
  const same = !r.package || !c.foreground || r.package === c.foreground;
  if (c.playing && same) out.state = 'playing';
  else if (!c.playing && r.state === 'playing') {
    // The session says playing and no sound is coming out: its position is a count from a stale report.
    out.state = 'not playing';
    delete out.position_s;
  }
  return out;
}

export async function command(op: Op, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (op === 'open') {
    const row = await send(op, args, (n) => !!(n.done_at && (n.checked_at || n.result?.ok === false)));
    if (!row) return { ok: false, error: 'no answer from the TV' };
    if (!row.done_at) return { ok: false, error: 'the TV app never answered the open' };
    if (!row.checked_at) return { ...row.result, verified: false, verify_error: 'the Pi did not report what the open led to' };
    const out = judge(row.result, { ok: true, ...row.outcome });
    if (out.ok && !out.playing) { out.ok = false; out.error = row.outcome?.error || `opened, but ${out.foreground || 'nothing'} is not playing 15 s later`; }
    return out;
  }
  if (op === 'now' || op === 'media') {
    const r = await answer(op, args);
    if (!r.ok) return r;
    const play = op === 'media' && args.action === 'play';
    // `play` on an Apple TV title page means its Play button, which only a key press reaches; a pause is
    // read a moment later, once the last of the sound has gone out. The title page's trailer reports no
    // length and the film does, so a length rules the page out and spares reading the screen (seconds).
    const apple = APPLE.test(String(r.package || '')) && (play || !r.duration_s);
    const c = await answer('check', { apple, play, wait: play ? 5 : 0, delay: op === 'media' && !play ? 1 : 0 });
    return judge(r, c);
  }
  if (!LEVELS.has(op) || args.value === undefined) return answer(op, args);
  const read = await answer(op, {});
  const after = await answer(op, args);
  return read.ok && read[op] !== undefined ? { ...after, before: read[op] } : after;
}

async function answer(op: Op | 'check', args: Record<string, unknown>): Promise<Record<string, any>> {
  const row = await send(op, args, (n) => !!n.done_at);
  return row ? row.result || { ok: false } : { ok: false, error: `no answer from the TV in ${timeout(op) / 1000}s` };
}

// The open's follow-up on the Pi: Prime's picker (up to 20 s), Apple TV's title page and its Play (up
// to 20 s), then sound starting (up to 15 s), after a wake.
const OPEN_TIMEOUT_MS = 110_000;
const timeout = (op: string) => op === 'open' ? OPEN_TIMEOUT_MS : op === 'check' ? CHECK_TIMEOUT_MS : WAKES.has(op) ? WAKE_TIMEOUT_MS : TIMEOUT_MS;

/** Writes the command and resolves with its row once `done` holds for it, or with the last row seen
 *  (null if none) when the time runs out. */
async function send(op: Op | 'check', args: Record<string, unknown>, done: (row: any) => boolean): Promise<any> {
  const sb = getClient();
  const id = randomUUID();
  let last: any = null;
  // Subscribed BEFORE the insert, so an answer faster than the subscription cannot be missed.
  return new Promise<any>((resolve) => {
    const ch = sb.channel(`tv-${id}`)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tv_commands', filter: `id=eq.${id}` },
        (p: any) => { last = p.new; if (done(p.new)) { sb.removeChannel(ch); resolve(p.new); } })
      .subscribe(async (status) => {
        if (status !== 'SUBSCRIBED') return;
        const { error } = await sb.from('tv_commands').insert({ id, op, args });
        if (error) { sb.removeChannel(ch); resolve({ done_at: 'now', result: { ok: false, error: error.message } }); }
      });
    setTimeout(() => { sb.removeChannel(ch); resolve(last); }, timeout(op));
  });
}

/** What the sidebar's content view shows (the hub's tv_sidebar_content setting). */
export async function sidebarContent(): Promise<string> {
  const { data, error } = await getClient().from('app_settings').select('value').eq('key', 'tv_sidebar_content').maybeSingle();
  if (error) throw new Error(error.message);
  return String(data?.value ?? '');
}
