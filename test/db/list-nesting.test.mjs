// Lists inside lists (migration 00184): no list may be its own ancestor, and a parent cannot be
// deleted out from under its sublists.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRollback } from './db.mjs';

const mk = (c, id, parent = null) => c.query(
  "insert into lists (id, name, parent_id, created) values ($1, $1, $2, '2026-11-23T10:00:00')", [id, parent]);

describe('list nesting', () => {
  test('a list can sit inside another, several levels deep', () => withRollback(async (c) => {
    await mk(c, 't_a'); await mk(c, 't_b', 't_a'); await mk(c, 't_c', 't_b');
    assert.equal((await c.query("select parent_id from lists where id = 't_c'")).rows[0].parent_id, 't_b');
  }));

  test('a list cannot be its own parent', () => withRollback(async (c) => {
    await mk(c, 't_a');
    await assert.rejects(c.query("update lists set parent_id = 't_a' where id = 't_a'"), /inside itself/);
  }));

  test('a list cannot move inside one of its own sublists', () => withRollback(async (c) => {
    await mk(c, 't_a'); await mk(c, 't_b', 't_a'); await mk(c, 't_c', 't_b');
    await assert.rejects(c.query("update lists set parent_id = 't_c' where id = 't_a'"), /inside itself/);
  }));

  test('a parent with sublists cannot be deleted directly', () => withRollback(async (c) => {
    await mk(c, 't_a'); await mk(c, 't_b', 't_a');
    await assert.rejects(c.query("delete from lists where id = 't_a'"), /foreign key/);
  }));
});
