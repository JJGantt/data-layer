// door_report() (migrations 00208, 00209, 00211): the one writer of door_events for every source, so which
// reports become rows is decided here. "The door opened at 9:14" and every automation built on door
// events read these rows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRollback } from './db.mjs';

async function setup(c) {
  await c.query('delete from door_sightings');
  await c.query('delete from door_events');
  await c.query("delete from device_status where device = 'front-door'");
  const report = async (source, lock, door, { seq = null, battery = null } = {}) =>
    (await c.query('select event, lock_state, door_state, source from door_report($1, $2, $3, $4, $5)',
      [source, lock, door, battery, seq])).rows;
  const status = async () => (await c.query("select status, data from device_status where device = 'front-door'")).rows[0];
  const sightings = async () => (await c.query(
    `select s.source, s.outcome, l.event as lock_of, d.event as door_of, s.sampled_at
       from door_sightings s left join door_events l on l.id = s.lock_event left join door_events d on d.id = s.door_event
      order by s.id`)).rows;
  return { report, status, sightings, c };
}

describe('door_report()', () => {
  test('the first report records what it carries', () => withRollback(async (c) => {
    const { report } = await setup(c);
    assert.deepEqual((await report('ble', 'locked', 'closed', { seq: 1 })).map((r) => r.event), ['locked', 'closed']);
  }));

  test('one row per value that changed, the other carried along', () => withRollback(async (c) => {
    const { report } = await setup(c);
    await report('ble', 'locked', 'closed', { seq: 1 });
    assert.deepEqual((await report('ble', 'unlocked', 'opened', { seq: 2 })).map((r) => [r.event, r.lock_state, r.door_state]),
      [['unlocked', 'unlocked', 'closed'], ['opened', 'unlocked', 'opened']]);
  }));

  test('the same change from a second source is not a second row', () => withRollback(async (c) => {
    const { report } = await setup(c);
    await report('ble', 'locked', 'closed', { seq: 1 });
    assert.equal((await report('command', 'unlocked', 'closed')).length, 1);
    assert.equal((await report('ble', 'unlocked', 'closed', { seq: 3 })).length, 0);
    assert.equal((await report('backstop', 'unlocked', 'closed')).length, 0);
  }));

  test('an omitted field keeps its previous value', () => withRollback(async (c) => {
    const { report } = await setup(c);
    await report('ble', 'unlocked', 'opened', { seq: 1 });
    assert.deepEqual((await report('webhook', null, 'closed')).map((r) => [r.event, r.lock_state, r.door_state]),
      [['closed', 'unlocked', 'closed']]);
  }));

  test('an older Bluetooth advert after a newer one is dropped, across the sequence wrap', () => withRollback(async (c) => {
    const { report } = await setup(c);
    await report('ble', 'locked', 'closed', { seq: 254 });
    assert.equal((await report('ble', 'unlocked', 'closed', { seq: 1 })).length, 1);   // 254 -> 1 is newer
    assert.equal((await report('ble', 'locked', 'closed', { seq: 255 })).length, 0);   // a late 255 is older
  }));

  test('device_status keeps the battery when a report carries none', () => withRollback(async (c) => {
    const { report, status } = await setup(c);
    await report('ble', 'locked', 'closed', { seq: 1, battery: 68 });
    await report('command', 'unlocked', null);
    const s = await status();
    assert.equal(s.status, 'unlocked');
    assert.deepEqual(s.data, { lock: 'unlocked', door: 'closed', battery: 68 });
  }));

  test('every source report is kept as a sighting, linked to the change it reported', () => withRollback(async (c) => {
    const { report, sightings } = await setup(c);
    await report('ble', 'locked', 'closed', { seq: 1 });
    await report('webhook', 'unlocked', 'closed');
    await report('ble', 'unlocked', 'closed', { seq: 2 });
    assert.deepEqual((await sightings()).map((s) => [s.source, s.outcome, s.lock_of, s.door_of]), [
      ['ble', 'new', 'locked', 'closed'],
      ['webhook', 'new', 'unlocked', 'closed'],
      ['ble', 'duplicate', 'unlocked', 'closed'],
    ]);
  }));

  test('a stale advert is kept as stale, and a backstop read that changed nothing is not kept', () => withRollback(async (c) => {
    const { report, sightings } = await setup(c);
    await report('ble', 'locked', 'closed', { seq: 10 });
    await report('ble', 'unlocked', 'closed', { seq: 9 });
    await report('backstop', 'locked', 'closed');
    await report('backstop', 'unlocked', 'closed');
    assert.deepEqual((await sightings()).map((s) => [s.source, s.outcome]),
      [['ble', 'new'], ['ble', 'stale'], ['backstop', 'new']]);
  }));

  test("the webhook's own sample time is kept", () => withRollback(async (c) => {
    const { sightings } = await setup(c);
    await c.query("select door_report('webhook', 'locked', 'closed', null, null, 'fly', $1)",
      [{ context: { timeOfSample: 1795813958335 } }]);
    assert.equal((await sightings())[0].sampled_at.toISOString(), '2026-11-27T21:12:38.335Z');
  }));

  test('door_event_sources lists every source that heard a change', () => withRollback(async (c) => {
    const { report } = await setup(c);
    await report('ble', 'locked', 'closed', { seq: 1 });
    await report('webhook', 'locked', 'closed');
    const rows = (await c.query("select event, recorded_by, heard_by from door_event_sources where event = 'locked'")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recorded_by, 'ble');
    assert.deepEqual(Object.keys(rows[0].heard_by).sort(), ['ble', 'webhook']);
  }));
});
