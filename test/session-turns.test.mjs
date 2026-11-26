// read_session's view of a session: every message he sent appears, whether it opened a turn, was read
// while a turn was running, or landed in a turn that never finished.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSessionTurns } from '../dist/desk.js';

const turn = (at, prompt, reply, during = []) => ({ at, prompt, reply, events: [
  { id: 'o', kind: 'prompt', seen: false, text: prompt }, { id: 'o', kind: 'prompt', seen: true, text: prompt },
  ...during.flatMap((t, i) => [{ id: `d${i}`, kind: 'prompt', seen: false, text: t }, { id: `d${i}`, kind: 'prompt', seen: true, text: t }]),
  { kind: 'tool', text: 'Bash' },
] });

test('a message read mid-turn is shown once, inside its turn', () => {
  const out = formatSessionTurns('S', [turn('2026-11-17T04:19:02Z', 'Run a test', 'Done', ['Hello?'])],
    [{ at: '2026-11-17T04:06:26Z', prompt: 'Run a test' }, { at: '2026-11-17T04:17:43Z', prompt: 'Hello?' }]);
  assert.equal(out.match(/Hello\?/g).length, 1);
  assert.match(out, /Jared, while it was working: Hello\?/);
  assert.doesNotMatch(out, /no finished turn/);
});

test('messages sent into a turn that never finished are shown in time order as unanswered', () => {
  const out = formatSessionTurns('S',
    [turn('2026-11-17T04:19:02Z', 'Run a test', 'Done'), turn('2026-11-17T04:34:03Z', 'Why did you end it', 'Stopped')],
    [{ at: '2026-11-17T04:20:45Z', prompt: 'Run names only' }, { at: '2026-11-17T04:29:12Z', prompt: 'Stop using the simulator' },
     { at: '2026-11-17T04:30:56Z', prompt: 'Why did you end it\n\nContext from the orchestrator: …' }]);
  const i = (s) => out.indexOf(s);
  assert.ok(i('Done') < i('Run names only') && i('Run names only') < i('Stop using the simulator') && i('Stop using the simulator') < i('Stopped'));
  assert.equal(out.match(/no finished turn/g).length, 2);
});

test('a session working now says so, and an empty one says it has nothing', () => {
  assert.match(formatSessionTurns('S', [turn('2026-11-17T04:19:02Z', 'a', 'b')], [], true), /working on a turn now/);
  assert.equal(formatSessionTurns('S', [], []), 'S: no finished turns recorded.');
  assert.match(formatSessionTurns('S', [], [{ at: '2026-11-17T04:20:45Z', prompt: 'hi' }]), /Jared: hi/);
});

test('a message no turn holds says whether its send actually delivered it', () => {
  const at = '2026-11-25T23:39:23Z';
  const failed = formatSessionTurns('S', [], [{ at, prompt: 'Okay, couple things', status: 'error',
    detail: 'Command failed: osascript -e tell application "Terminal"\n  do script "Okay, couple things"\n59:505: execution error: Terminal got an error: AppleEvent timed out. (-1712)' }]);
  assert.match(failed, /NOT DELIVERED: the send failed: 59:505: execution error: Terminal got an error: AppleEvent timed out/);
  assert.doesNotMatch(failed, /DELIVERED, but/);
  assert.match(formatSessionTurns('S', [], [{ at, prompt: 'hi', status: 'done', detail: 'sent 2 chars to /dev/ttys014' }]),
    /DELIVERED \(sent 2 chars to \/dev\/ttys014\), but no finished turn has answered it yet/);
  assert.match(formatSessionTurns('S', [], [{ at, prompt: 'hi', status: 'running' }]), /NOT DELIVERED YET: its command is still running/);
});
