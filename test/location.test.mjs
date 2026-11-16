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
