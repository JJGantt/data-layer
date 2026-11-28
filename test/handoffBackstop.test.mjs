// When a handoff's backstop read finding the row already changed is a deaf channel (src/handoff.ts backstopMiss).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backstopMiss, DELIVERY_GRACE_MS, JOIN_SETTLE_MS } from '../dist/handoff.js';

const t0 = Date.parse('2026-11-28T00:58:03.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('channel never subscribed: a race, not deaf', () => {
  assert.equal(backstopMiss(null, iso(t0), t0 + 10_000), 'race');
});

test('subscribed and settled, change visible longer than the grace with no event: deaf', () => {
  const ch = t0 + JOIN_SETTLE_MS + 100;
  assert.equal(backstopMiss(t0, iso(ch), ch + DELIVERY_GRACE_MS), 'deaf');
});

test('subscribed and settled, change still inside the grace: a race', () => {
  assert.equal(backstopMiss(t0, iso(t0 + 2_000), t0 + 3_000), 'race');
});

test('change made before the channel was up, or while it settled: a race, however long ago', () => {
  assert.equal(backstopMiss(t0 + 2_500, iso(t0 + 500), t0 + 3_100), 'race');
  assert.equal(backstopMiss(t0 + 500, iso(t0), t0 + 120_000), 'race');
  // #717: a drive refresh answered 0.5 s after a fresh channel subscribed, read by the backstop 2.6 s later
  assert.equal(backstopMiss(t0, iso(t0 + 500), t0 + 3_100), 'race');
});

test('no updated_at: counts from when it subscribed', () => {
  assert.equal(backstopMiss(t0, undefined, t0 + 1_000), 'race');
  assert.equal(backstopMiss(t0, undefined, t0 + 120_000), 'deaf');
});
