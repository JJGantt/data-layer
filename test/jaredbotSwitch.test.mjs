import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isOn } from '../dist/jaredbotSwitch.js';

test('only a clear yes turns JaredBot on', () => {
  for (const v of ['1', 'true', 'on', 'yes', ' ON ']) assert.equal(isOn(v), true, v);
  for (const v of ['0', '', 'off', 'no', 'false', null, undefined, '2']) assert.equal(isOn(v), false, String(v));
});
