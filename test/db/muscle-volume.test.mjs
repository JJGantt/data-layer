// muscle_volume() (migration 00156): the one definition of weekly volume, read by get_weekly_volume and
// the hub's muscle gauges. Its window, bouts and cap decide every number on both.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRollback } from './db.mjs';

// Fixtures are placed relative to the function's own "today" (the training day, 4am New York), so the
// tests hold whenever they run.
async function setup(c) {
  await c.query('delete from sets');
  await c.query("delete from app_settings where key = 'display_tz'");
  const { rows: [{ today }] } = await c.query(
    "select to_char(((now() at time zone 'America/New_York') - interval '4 hours')::date, 'YYYY-MM-DD') as today");
  const { rows: [press] } = await c.query(
    "insert into exercise_catalog (name, categories) values ('Test Press', '{push}') returning id");
  await c.query(
    "insert into exercise_muscles (name, exercise_id, muscle, contribution) values ('Test Press', $1, 'chest', 1), ('Test Press', $1, 'triceps', 0.5)",
    [press.id]);
  const day = (offset) => {
    const [y, m, d] = today.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10);
  };
  const addSets = async (times, override = null) => {
    for (const t of times) {
      await c.query('insert into sets (occurred_at, exercise_id, weight_lbs, reps, muscles_override) values ($1, $2, 100, 8, $3)',
        [t, press.id, override && JSON.stringify(override)]);
    }
  };
  const volume = async (days = 7) => (await c.query('select muscle_volume($1) as v', [days])).rows[0].v;
  return { today, day, addSets, volume };
}

const times = (date, start, n, stepMin = 2) => Array.from({ length: n }, (_, i) => {
  const [h, m] = start.split(':').map(Number);
  const t = h * 60 + m + i * stepMin;
  return `${date}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}:00`;
});
const bouts = (v, muscle) => v.bouts.filter((b) => b.muscle === muscle).map((b) => ({ day: b.day, sets: Number(b.sets) }))
  .sort((a, b) => a.day.localeCompare(b.day) || a.sets - b.sets);

describe('muscle_volume() window', () => {
  test('is p_days training days ending today, at least one', () => withRollback(async (c) => {
    const { today, day, volume } = await setup(c);
    const v = await volume(7);
    assert.equal(v.window.length, 7);
    assert.equal(v.window[0], day(-6));
    assert.equal(v.window.at(-1), today);
    assert.deepEqual((await volume(0)).window, [today]);
  }));

  test('starts at 4am on its first day', () => withRollback(async (c) => {
    const { day, addSets, volume } = await setup(c);
    await addSets([`${day(-6)}T03:59:00`]);
    assert.deepEqual(bouts(await volume(7), 'chest'), []);
    await addSets([`${day(-6)}T04:00:00`]);
    assert.deepEqual(bouts(await volume(7), 'chest'), [{ day: day(-6), sets: 1 }]);
  }));

  test('a set before 4am belongs to the previous day', () => withRollback(async (c) => {
    const { day, addSets, volume } = await setup(c);
    await addSets([`${day(-1)}T01:30:00`]);
    const v = await volume(7);
    assert.deepEqual(bouts(v, 'chest'), [{ day: day(-2), sets: 1 }]);
    assert.deepEqual(v.days.filter((d) => d.muscle === 'chest').map((d) => d.day), [day(-2)]);
  }));
});

describe('muscle_volume() credit', () => {
  test('a set credits its exercise\'s muscles at their contribution', () => withRollback(async (c) => {
    const { day, addSets, volume } = await setup(c);
    await addSets(times(day(-1), '10:00', 4));
    const v = await volume(7);
    assert.deepEqual(bouts(v, 'chest'), [{ day: day(-1), sets: 4 }]);
    assert.deepEqual(bouts(v, 'triceps'), [{ day: day(-1), sets: 2 }]);
  }));

  test('a set\'s own muscle override replaces the exercise\'s muscles', () => withRollback(async (c) => {
    const { day, addSets, volume } = await setup(c);
    await addSets(times(day(-1), '10:00', 2), { front_delts: 1, chest: 0.25 });
    const v = await volume(7);
    assert.deepEqual(bouts(v, 'front_delts'), [{ day: day(-1), sets: 2 }]);
    assert.deepEqual(bouts(v, 'chest'), [{ day: day(-1), sets: 0.5 }]);
    assert.deepEqual(bouts(v, 'triceps'), []);
  }));
});

describe('muscle_volume() bouts and the cap', () => {
  test('a muscle earns at most 11 sets in one bout; the uncapped count is kept per day', () => withRollback(async (c) => {
    const { day, addSets, volume } = await setup(c);
    await addSets(times(day(-1), '10:00', 15));
    const v = await volume(7);
    assert.deepEqual(bouts(v, 'chest'), [{ day: day(-1), sets: 11 }]);
    assert.equal(Number(v.days.find((d) => d.muscle === 'chest').raw), 15);
  }));

  test('a gap of exactly 3 hours is the same bout; more starts a new one, capped separately', () => withRollback(async (c) => {
    const { day, addSets, volume } = await setup(c);
    await addSets([...times(day(-1), '10:00', 6, 1), ...times(day(-1), '13:05', 6, 1)]);   // 10:05 to 13:05
    assert.deepEqual(bouts(await volume(7), 'chest'), [{ day: day(-1), sets: 11 }]);
    await c.query('delete from sets');
    await addSets([...times(day(-1), '10:00', 6, 1), ...times(day(-1), '13:06', 6, 1)]);   // 10:05 to 13:06
    assert.deepEqual(bouts(await volume(7), 'chest'), [{ day: day(-1), sets: 6 }, { day: day(-1), sets: 6 }]);
  }));

  test('a bout that runs past 4am belongs to the day of its last set', () => withRollback(async (c) => {
    const { day, addSets, volume } = await setup(c);
    await addSets([`${day(-2)}T23:00:00`, `${day(-1)}T01:30:00`, `${day(-1)}T04:30:00`]);
    const v = await volume(7);
    assert.deepEqual(bouts(v, 'chest'), [{ day: day(-1), sets: 3 }]);
    assert.deepEqual(v.days.filter((d) => d.muscle === 'chest').map((d) => [d.day, Number(d.raw)]).sort(),
      [[day(-2), 2], [day(-1), 1]]);
  }));
});

describe('muscle_volume() targets', () => {
  test('come from muscle_volume_targets, with a default for the rest', () => withRollback(async (c) => {
    const { volume } = await setup(c);
    await c.query("update muscle_volume_targets set target = 9 where muscle = 'abs'");
    const t = (await volume(7)).targets;
    assert.equal(Number(t.abs), 9);
    assert.equal(Number(t._default), 14);
    assert.equal(t.chest, undefined);
  }));
});
