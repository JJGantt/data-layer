// When a handoff's backstop read finding the row already changed is a deaf channel (src/handoff.ts backstopMiss).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backstopMiss, DELIVERY_GRACE_MS } from '../dist/handoff.js';

const t0 = Date.parse('2026-11-28T00:58:03.000Z');
const iso = (ms) => new Date(ms).toISOString();

test('channel never subscribed: a race, not deaf', () => {
  assert.equal(backstopMiss(null, iso(t0), t0 + 10_000), 'race');
});

test('subscribed, change visible longer than the grace with no event: deaf', () => {
  assert.equal(backstopMiss(t0, iso(t0 + 100), t0 + 100 + DELIVERY_GRACE_MS), 'deaf');
});

test('subscribed, change still inside the grace: a race', () => {
  assert.equal(backstopMiss(t0, iso(t0 + 2_000), t0 + 3_000), 'race');
});

test('change made before the channel was up counts from when it subscribed', () => {
  assert.equal(backstopMiss(t0 + 2_500, iso(t0 + 500), t0 + 3_100), 'race');
  assert.equal(backstopMiss(t0 + 500, iso(t0), t0 + 120_000), 'deaf');
});

test('no updated_at: counts from when it subscribed', () => {
  assert.equal(backstopMiss(t0, undefined, t0 + 1_000), 'race');
  assert.equal(backstopMiss(t0, undefined, t0 + 120_000), 'deaf');
});
