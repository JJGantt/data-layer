import { test } from 'node:test';
import assert from 'node:assert/strict';
import { frontier, describe } from '../dist/location.js';

const f = (device, min, acc, extra = {}) => ({ device, lat: 30.29, lon: -81.71, acc, at: new Date(Date.UTC(2026, 10, 16, 20, min)).toISOString(), ...extra });

test('frontier keeps the newest fix, then only older fixes more precise than everything newer', () => {
  const coarse = f('watch', 34, 9175), cell = f('phone', 33, 600), worse = f('phone', 31, 900), gps = f('phone', 30, 20);
  assert.deepEqual(frontier([gps, coarse, worse, cell]), [coarse, cell, gps]);
});

test('the walk stops at the first GPS-grade fix', () => {
  assert.deepEqual(frontier([f('phone', 40, 8), f('phone', 20, 2)]).map(x => x.acc), [8]);
});

test('a newest fix that is also the most precise stands alone', () => {
  assert.deepEqual(frontier([f('web', 10, 5), f('phone', 40, 4), f('watch', 30, 100)]).map(x => x.device), ['phone']);
});

test('unknown accuracy never beats a known one', () => {
  assert.deepEqual(frontier([f('web', 40, null), f('phone', 30, 50)]).map(x => x.device), ['web', 'phone']);
});

test('describe states device, kind of fix, accuracy and age', () => {
  const now = Date.UTC(2026, 10, 16, 20, 40);
  assert.equal(describe([f('phone', 35, 6.4, { source: 'fix' })], now), '30.29000, -81.71000 (within about 6 m), from the phone, 5 min ago');
  assert.match(describe([]), /No position/);
});

import { timeline, nyInstant } from '../dist/location.js';

const p = (min, lat, acc, extra = {}) => ({ device: 'phone', lat, lon: -81.7, acc, at: new Date(Date.UTC(2026, 10, 16, 19, 0) + min * 60e3).toISOString(), ...extra });

test('timeline: a run at one place for minutes is a stay, a short pause on a trip is not', () => {
  const segs = timeline([p(0, 30.0, 5), p(20, 30.0, 5), p(30, 30.0, 11, { source: 'depart' }), p(35, 30.05, 5), p(36, 30.05, 5), p(45, 30.1, 4)]);
  assert.deepEqual(segs.map(s => s.kind), ['stay', 'fix', 'fix', 'fix']);
  assert.equal(segs[0].to, Date.UTC(2026, 10, 16, 19, 30));
});

test('timeline: a coarse fix near a GPS fix is dropped; a visit is kept whatever its accuracy', () => {
  const segs = timeline([p(0, 30.0, 5), p(1, 30.2, 9000), p(10, 30.0, 55, { source: 'arrive' })]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'stay');
});

test('timeline: the same instant stored twice is one fix', () => {
  assert.equal(timeline([p(0, 30.0, 5), p(0, 30.0, 5, { source: 'move' })]).length, 1);
});

test('nyInstant reads New York wall clock on both sides of DST', () => {
  assert.equal(new Date(nyInstant('2026-11-16T20:30')).toISOString(), '2026-11-17T01:30:00.000Z');
  assert.equal(new Date(nyInstant('2026-07-01T09:00')).toISOString(), '2026-07-01T13:00:00.000Z');
  assert.throws(() => nyInstant('2026-02-30T10:00'));
  assert.throws(() => nyInstant('8:30 pm'));
});
