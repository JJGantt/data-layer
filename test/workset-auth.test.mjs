// The Watchset watch app's device token check (supabase/functions/workset/auth.mjs): the only thing
// between the internet and a write into the training log, since anon has no grant on workset_reports.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { deviceAuthorised, sha256Hex } from '../supabase/functions/workset/auth.mjs';

describe('workset device token', () => {
  test('a token whose digest is configured is accepted', async () => {
    assert.equal(await deviceAuthorised('watch-token', await sha256Hex('watch-token')), true);
  });

  test('any of several configured devices is accepted, case and spacing aside', async () => {
    const list = `${await sha256Hex('a')} , ${(await sha256Hex('b')).toUpperCase()}`;
    assert.equal(await deviceAuthorised('a', list), true);
    assert.equal(await deviceAuthorised('b', list), true);
  });

  test('a wrong token is refused', async () => {
    assert.equal(await deviceAuthorised('not-it', await sha256Hex('watch-token')), false);
  });

  test('the digest itself is not a token', async () => {
    const h = await sha256Hex('watch-token');
    assert.equal(await deviceAuthorised(h, h), false);
  });

  test('no token, or nothing configured, refuses everything', async () => {
    assert.equal(await deviceAuthorised('', await sha256Hex('')), false);
    assert.equal(await deviceAuthorised('watch-token', ''), false);
    assert.equal(await deviceAuthorised('watch-token', 'not-a-digest'), false);
  });
});
