import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phoneFrozeMs } from '../dist/screenAgent.js';

test('a failed share is counted only when the phone reported its page frozen', () => {
  assert.equal(phoneFrozeMs({ why: 'no picture', frozen_ms: 13000 }), 13000);
  assert.equal(phoneFrozeMs({ why: 'no picture', frozen_ms: null }), 0);
  assert.equal(phoneFrozeMs({ why: 'no picture' }), 0);
  assert.equal(phoneFrozeMs(null), 0);
  assert.equal(phoneFrozeMs(undefined), 0);
  assert.equal(phoneFrozeMs({ frozen_ms: 'x' }), 0);
});
