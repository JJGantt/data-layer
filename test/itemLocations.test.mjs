import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rosterToken } from '../dist/itemLocations.js';

const rows = (...names) => names.map(item => ({ item, location: 'somewhere', updated_at: '2026-11-23T10:00:00' }));

test('the seen token depends only on which items exist', () => {
  const t = rosterToken(rows('passport', 'charger'));
  assert.equal(rosterToken(rows('Charger ', 'PASSPORT')), t, 'order, case and padding do not change it');
  assert.equal(rosterToken([{ ...rows('passport')[0], location: 'safe' }, ...rows('charger')]), t, 'a moved item does not change it');
  assert.notEqual(rosterToken(rows('passport', 'charger', 'keys')), t, 'a new item changes it');
  assert.notEqual(rosterToken(rows('passport')), t, 'a removed item changes it');
});
