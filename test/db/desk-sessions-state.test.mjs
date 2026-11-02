// desk_sessions_state() (migration 00157): which number each session has and which one is focused, the
// one definition the voice tools and the hub's wall both read. "Session three" and a follow-up's
// destination come from here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRollback } from './db.mjs';

async function setup(c) {
  await c.query('delete from desk_focus');
  await c.query('delete from desk_sessions');
  await c.query('delete from desk_commands');
  const session = (id, { status = 'resident', conv = null, active = null, reply = null, started = '2026-06-01T08:00:00Z', seen = '2026-06-01T08:00:00Z', command = null } = {}) =>
    c.query(`insert into desk_sessions (id, worker, repo, status, claude_session_id, active_at, reply_at, started, last_seen, command_id)
             values ($1, 'pi-desk', 'repo', $2, $3, $4, $5, $6, $7, $8)`, [id, status, conv, active, reply, started, seen, command]);
  const focus = (session_id, command_id = null) =>
    c.query("insert into desk_focus (id, session_id, command_id) values ('current', $1, $2)", [session_id, command_id]);
  const command = async (status) =>
    (await c.query("insert into desk_commands (kind, status) values ('open_session', $1) returning id::text", [status])).rows[0].id;
  const state = async () => (await c.query('select desk_sessions_state() as s')).rows[0].s;
  return { session, focus, command, state };
}

describe('desk_sessions_state() numbering', () => {
  test('1 is the most recently active; running and parked interleave; closed rows are not numbered', () => withRollback(async (c) => {
    const { session, state } = await setup(c);
    await session('a', { active: '2026-06-01T10:00:00Z' });
    await session('b', { status: 'evicted', active: '2026-06-01T12:00:00Z' });
    await session('c', { active: '2026-06-01T11:00:00Z' });
    await session('d', { status: 'ended', active: '2026-06-01T13:00:00Z' });
    assert.deepEqual((await state()).numbers, { b: 1, c: 2, a: 3 });
  }));

  test('activity falls back from active_at to reply_at to started', () => withRollback(async (c) => {
    const { session, state } = await setup(c);
    await session('a', { started: '2026-06-01T09:00:00Z' });
    await session('b', { reply: '2026-06-01T10:00:00Z', started: '2026-06-01T07:00:00Z' });
    await session('c', { active: '2026-06-01T08:30:00Z', reply: '2026-06-01T11:00:00Z' });
    assert.deepEqual((await state()).numbers, { b: 1, a: 2, c: 3 });
  }));

  test('one number per conversation: its running row if it runs, else its latest', () => withRollback(async (c) => {
    const { session, state } = await setup(c);
    await session('old', { status: 'evicted', conv: 'x', active: '2026-06-01T12:00:00Z' });
    await session('new', { conv: 'x', active: '2026-06-01T10:00:00Z' });
    await session('p1', { status: 'evicted', conv: 'y', active: '2026-06-01T09:00:00Z' });
    await session('p2', { status: 'evicted', conv: 'y', active: '2026-06-01T11:00:00Z' });
    assert.deepEqual((await state()).numbers, { p2: 1, new: 2 });
  }));

  test('nothing open numbers nothing and focuses nothing', () => withRollback(async (c) => {
    const { state } = await setup(c);
    assert.deepEqual(await state(), { numbers: {}, focus: { session_id: null, pinned: false, pending: false } });
  }));
});

describe('desk_sessions_state() focus', () => {
  test('unpinned, focus is the most recently active running session', () => withRollback(async (c) => {
    const { session, state } = await setup(c);
    await session('a', { active: '2026-06-01T10:00:00Z' });
    await session('b', { active: '2026-06-01T11:00:00Z' });
    await session('c', { status: 'evicted', active: '2026-06-01T12:00:00Z' });
    assert.deepEqual((await state()).focus, { session_id: 'b', pinned: false, pending: false });
  }));

  test('a pin holds against a more recently active session', () => withRollback(async (c) => {
    const { session, focus, state } = await setup(c);
    await session('a', { active: '2026-06-01T10:00:00Z' });
    await session('b', { active: '2026-06-01T11:00:00Z' });
    await focus('a');
    assert.deepEqual((await state()).focus, { session_id: 'a', pinned: true, pending: false });
  }));

  test('a pin follows its conversation to the resumed row', () => withRollback(async (c) => {
    const { session, focus, state } = await setup(c);
    await session('first', { status: 'evicted', conv: 'x', active: '2026-06-01T09:00:00Z' });
    await session('resumed', { conv: 'x', active: '2026-06-01T10:00:00Z' });
    await session('other', { active: '2026-06-01T11:00:00Z' });
    await focus('first');
    assert.deepEqual((await state()).focus, { session_id: 'resumed', pinned: true, pending: false });
  }));

  test('a pinned session that is parked stays pinned', () => withRollback(async (c) => {
    const { session, focus, state } = await setup(c);
    await session('parked', { status: 'evicted', conv: 'x' });
    await session('other', { active: '2026-06-01T11:00:00Z' });
    await focus('parked');
    assert.deepEqual((await state()).focus, { session_id: 'parked', pinned: true, pending: false });
  }));

  test('a pin to a row that no longer exists falls back to automatic focus', () => withRollback(async (c) => {
    const { session, focus, state } = await setup(c);
    await session('a', { active: '2026-06-01T10:00:00Z' });
    await focus('gone');
    assert.deepEqual((await state()).focus, { session_id: 'a', pinned: false, pending: false });
  }));

  test('a dispatch whose session has not opened yet is pending', () => withRollback(async (c) => {
    const { session, focus, command, state } = await setup(c);
    await session('a', { active: '2026-06-01T10:00:00Z' });
    await focus(null, await command('pending'));
    assert.deepEqual((await state()).focus, { session_id: null, pinned: false, pending: true });
  }));

  test('once the dispatched session exists, or the command is finished, focus is automatic again', () => withRollback(async (c) => {
    const { session, focus, command, state } = await setup(c);
    const running = await command('running');
    await session('a', { active: '2026-06-01T10:00:00Z' });
    await session('opened', { active: '2026-06-01T09:00:00Z', command: running });
    await focus(null, running);
    assert.deepEqual((await state()).focus, { session_id: 'a', pinned: false, pending: false });
    await c.query('delete from desk_focus');
    await focus(null, await command('done'));
    assert.deepEqual((await state()).focus, { session_id: 'a', pinned: false, pending: false });
  }));

  test('a pin outranks a pending dispatch', () => withRollback(async (c) => {
    const { session, focus, command, state } = await setup(c);
    await session('a', { active: '2026-06-01T10:00:00Z' });
    await focus('a', await command('pending'));
    assert.deepEqual((await state()).focus, { session_id: 'a', pinned: true, pending: false });
  }));
});
