// read_conversation: which conversation day a message belongs to (4 AM origin, display zone), and how a
// past day's rows are printed back to the model.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dayStartUtc, dayOf, addDays, formatRows } from '../dist/conversation.js';

describe('conversation day', () => {
  test('starts at 4 AM local, EST and EDT alike', () => {
    assert.equal(dayStartUtc('2026-11-09').toISOString(), '2026-11-09T09:00:00.000Z');   // EST
    assert.equal(dayStartUtc('2026-07-04').toISOString(), '2026-07-04T08:00:00.000Z');   // EDT
  });
  test('the DST changeover days start at their own 4 AM', () => {
    assert.equal(dayStartUtc('2026-03-08').toISOString(), '2026-03-08T08:00:00.000Z');   // after spring-forward
    assert.equal(dayStartUtc('2026-11-01').toISOString(), '2026-11-01T09:00:00.000Z');   // after fall-back
  });
  test('a message before 4 AM belongs to the previous day', () => {
    assert.equal(dayOf('2026-11-09T08:59:00Z'), '2026-11-08');   // 3:59 AM EST
    assert.equal(dayOf('2026-11-09T09:00:00Z'), '2026-11-09');   // 4:00 AM EST
    assert.equal(dayOf('2026-11-10T04:30:00Z'), '2026-11-09');   // 11:30 PM EST
  });
  test('addDays crosses month and year ends', () => {
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
});

describe('formatRows', () => {
  test('heads each day, marks ignored room noise and relayed sessions, drops the ignore sentinel', () => {
    const out = formatRows([
      { role: 'user', text: 'what was that ramen place', created_at: '2026-11-08T23:05:00Z' },
      { role: 'assistant', text: '__IGNORE__', created_at: '2026-11-08T23:05:10Z' },
      { role: 'user', text: 'pass the salt', created_at: '2026-11-09T02:00:00Z', ignored: true },
      { role: 'assistant', text: 'Done.', created_at: '2026-11-09T15:00:00Z', session_id: 's-1', session_label: 'Cart' },
    ]);
    assert.equal(out, [
      '=== Sunday, Nov 8, 2026 (2026-11-08) ===',
      '[6:05 PM] You: what was that ramen place',
      '[9:00 PM] You (ignored as room noise, not acted on): pass the salt',
      '',
      '=== Monday, Nov 9, 2026 (2026-11-09) ===',
      '[10:00 AM] Session "Cart" (s-1): Done.',
    ].join('\n'));
  });
});
