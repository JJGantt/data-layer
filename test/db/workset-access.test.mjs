// Who may write a Watchset report (migration 00160). A report becomes a logged set by trigger, so a
// client key that can insert one writes into the training log. Only the service role, which the
// `workset` edge function uses after checking the device token, may.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRollback } from './db.mjs';

const asRole = async (c, role, sql, params = []) => {
  await c.query('savepoint s');
  await c.query(`set local role ${role}`);
  try {
    return await c.query(sql, params);
  } finally {
    await c.query('rollback to savepoint s');
  }
};

async function report(c) {
  return (await c.query(
    "insert into workset_reports (reps, occurred_at, session, algorithm) values (8, now(), 'watch', 'test') returning id")).rows[0].id;
}

describe('workset_reports access', () => {
  for (const role of ['anon', 'authenticated']) {
    test(`${role} cannot file a report`, () => withRollback(async (c) => {
      await assert.rejects(
        asRole(c, role, "insert into workset_reports (reps, occurred_at, session, algorithm) values (8, now(), 'watch', 'x')"),
        /permission denied/);
    }));

    test(`${role} cannot amend a recent report`, () => withRollback(async (c) => {
      const id = await report(c);
      await assert.rejects(asRole(c, role, 'update workset_reports set deleted = true where id = $1', [id]), /permission denied/);
      await assert.rejects(asRole(c, role, 'update workset_reports set corrected_reps = 3 where id = $1', [id]), /permission denied/);
    }));

    test(`${role} cannot read the armed watcher`, () => withRollback(async (c) => {
      await assert.rejects(asRole(c, role, 'select * from workset_watcher()'), /permission denied/);
    }));
  }

  test('the service role files and amends reports', () => withRollback(async (c) => {
    const { rows } = await asRole(c, 'service_role',
      "insert into workset_reports (reps, occurred_at, session, algorithm) values (8, now(), 'watch', 'x') returning id");
    assert.equal(rows.length, 1);
    const id = await report(c);
    const upd = await asRole(c, 'service_role', 'update workset_reports set corrected_reps = 9 where id = $1', [id]);
    assert.equal(upd.rowCount, 1);
    const w = await asRole(c, 'service_role', 'select * from workset_watcher()');
    assert.equal(w.rows.length, 1);
  }));
});
