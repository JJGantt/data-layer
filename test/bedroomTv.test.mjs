// What the bedroom_tv tool reports about playback: the app's media-session answer, corrected by the Pi's
// look at the TV (whether the app is sending sound, and Apple TV's title page).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../dist/bedroomTv.js';

const APPLE = 'com.apple.atve.androidtv.appletv';
const YT = 'com.google.android.youtube.tv';

describe('judge', () => {
  test('a session that says playing while no sound comes out is not playing, and its position is dropped', () => {
    const r = judge({ ok: true, state: 'playing', package: APPLE, position_s: 43, duration_s: 6428 },
      { ok: true, foreground: APPLE, playing: false });
    assert.equal(r.state, 'not playing');
    assert.equal(r.playing, false);
    assert.equal(r.position_s, undefined);
    assert.equal(r.duration_s, 6428);
  });

  test('sound from the app in front confirms it is playing', () => {
    const r = judge({ ok: true, state: 'playing', package: YT, position_s: 90 }, { ok: true, foreground: YT, playing: true });
    assert.equal(r.state, 'playing');
    assert.equal(r.playing, true);
    assert.equal(r.position_s, 90);
  });

  test('a paused session stays paused with its position', () => {
    const r = judge({ ok: true, state: 'paused', package: YT, position_s: 90 }, { ok: true, foreground: YT, playing: false });
    assert.equal(r.state, 'paused');
    assert.equal(r.position_s, 90);
  });

  test('sound from a different app does not make the session\'s app playing', () => {
    const r = judge({ ok: true, state: 'paused', package: APPLE }, { ok: true, foreground: YT, playing: true });
    assert.equal(r.state, 'paused');
  });

  test('an Apple TV title page that sells something is a failure naming its button', () => {
    const r = judge({ ok: true, state: 'playing', package: APPLE, position_s: 8 },
      { ok: true, foreground: APPLE, playing: false, title_page: true, button: 'Accept Free Trial', sells: true });
    assert.equal(r.ok, false);
    assert.equal(r.state, 'title page');
    assert.match(r.error, /Accept Free Trial/);
    assert.equal(r.position_s, undefined);
  });

  test('a title page still there after Play was pressed is a failure', () => {
    const r = judge({ ok: true }, { ok: true, playing: false, title_page: true, button: 'Play', pressed: 'Play' });
    assert.equal(r.ok, false);
    assert.match(r.error, /pressed "Play"/);
  });

  test('a check that could not run leaves the answer as the app gave it, marked unverified', () => {
    const r = judge({ ok: true, state: 'playing', package: YT, position_s: 5 }, { ok: false, error: 'no answer' });
    assert.equal(r.state, 'playing');
    assert.equal(r.verified, false);
  });

  test('a failed command is passed through untouched', () => {
    const r = { ok: false, error: 'the TV is off' };
    assert.deepEqual(judge(r, { ok: true, playing: true }), r);
  });
});
