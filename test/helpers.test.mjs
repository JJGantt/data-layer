// The clock. now() is the moment Jared started speaking when the voice worker has written one, and
// this machine's wall clock otherwise (CLAUDE.md, "`now()` is not the current time").
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { now, today, toEastern, ensureEasternDate } from '../dist/helpers.js';

const dir = mkdtempSync(join(tmpdir(), 'data-layer-test-'));
const tsFile = join(dir, 'ts');
const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

afterEach(() => { delete process.env.DATA_TS_FILE; });
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

describe('now()', () => {
  test('reads the capture time from the file on every call, as local wall clock', () => {
    process.env.DATA_TS_FILE = tsFile;
    writeFileSync(tsFile, '2026-11-01T13:30:00Z');
    assert.equal(now(), '2026-11-01T08:30:00');          // EST, after the change
    writeFileSync(tsFile, '2026-07-04T16:00:00.123+00:00\n');
    assert.equal(now(), '2026-07-04T12:00:00');          // EDT
    assert.equal(today(), '2026-07-04');
  });

  test('a stamp with no zone is UTC', () => {
    process.env.DATA_TS_FILE = tsFile;
    writeFileSync(tsFile, '2026-07-04T02:00:00');
    assert.equal(now(), '2026-07-03T22:00:00');
    assert.equal(today(), '2026-07-03');
  });

  test('falls back to the real clock when the file is empty, unreadable or nonsense', () => {
    for (const setup of [() => writeFileSync(tsFile, ''), () => writeFileSync(tsFile, 'not a time'), () => rmSync(tsFile, { force: true })]) {
      setup();
      process.env.DATA_TS_FILE = tsFile;
      const before = toEastern(new Date());
      const n = now();
      assert.match(n, stamp);
      assert.ok(n >= before && n <= toEastern(new Date()));
    }
  });
});

describe('toEastern', () => {
  test('formats an instant as this machine\'s local reading, with no zone', () => {
    assert.equal(toEastern(new Date('2026-03-08T07:30:00Z')), '2026-03-08T03:30:00');   // just after spring forward
    assert.equal(toEastern(new Date('2026-03-08T06:30:00Z')), '2026-03-08T01:30:00');
  });
});

describe('ensureEasternDate', () => {
  test('a bare date is kept; a UTC timestamp becomes the local date', () => {
    assert.equal(ensureEasternDate('2026-11-01'), '2026-11-01');
    assert.equal(ensureEasternDate('2026-11-02T03:00:00Z'), '2026-11-01');
    assert.equal(ensureEasternDate('2026-11-02T03:00:00'), '2026-11-01');
  });
});
