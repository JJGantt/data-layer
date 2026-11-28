// Where onInserts' catch-up read starts after a channel subscribes (src/realtime.ts catchUpFrom).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catchUpFrom } from '../dist/realtime.js';

const now = Date.parse('2026-11-28T02:03:47.000Z');

test('process start just before subscribing: from a little before the start', () => {
  assert.equal(catchUpFrom(now - 1_000, now), now - 3_000);
});

test('a long gap is capped to the last 30 s', () => {
  assert.equal(catchUpFrom(now - 5 * 60_000, now), now - 30_000);
});

test('a recycled deaf channel (gap unknown) reads the last 30 s', () => {
  assert.equal(catchUpFrom(0, now), now - 30_000);
});
