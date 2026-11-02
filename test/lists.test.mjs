// Dated items: how a repeat expands, when an item is overdue, and which completion times are honoured.
// Times are naive local wall clock throughout (CLAUDE.md, "A time the user stated is stored verbatim").
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { seriesOccurrences, checkCompletedAt, isExpired, lateness, SERIES_DEFAULT_HORIZON_DAYS } from '../dist/lists.js';

describe('seriesOccurrences', () => {
  test('daily, first occurrence included, through the until date', () => {
    assert.deepEqual(seriesOccurrences('2026-06-01T08:00', '1 day', '2026-06-04'),
      ['2026-06-01T08:00', '2026-06-02T08:00', '2026-06-03T08:00', '2026-06-04T08:00']);
  });

  test('keeps the wall-clock time across both DST changes', () => {
    assert.deepEqual(seriesOccurrences('2026-10-31T08:00', '1 day', '2026-11-02'),
      ['2026-10-31T08:00', '2026-11-01T08:00', '2026-11-02T08:00']);
    assert.deepEqual(seriesOccurrences('2026-03-07T21:30', '1 week', '2026-03-14'),
      ['2026-03-07T21:30', '2026-03-14T21:30']);
  });

  test('a date-only series lands on each date once across a DST change', () => {
    assert.deepEqual(seriesOccurrences('2026-10-31', '1 day', '2026-11-03'),
      ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03']);
  });

  test('monthly steps from the anchor, so a 31st clamps per month without sticking', () => {
    assert.deepEqual(seriesOccurrences('2026-01-31', '1 month', '2026-05-31'),
      ['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  test('yearly from Feb 29 clamps to Feb 28 and returns to the 29th in a leap year', () => {
    assert.deepEqual(seriesOccurrences('2028-02-29', '1 year', '2032-03-01'),
      ['2028-02-29', '2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29']);
  });

  test('every 12 hours, and units in plural', () => {
    assert.deepEqual(seriesOccurrences('2026-06-01T09:00', '12 hours', '2026-06-02'),
      ['2026-06-01T09:00', '2026-06-01T21:00', '2026-06-02T09:00', '2026-06-02T21:00']);
  });

  test('with no until date the horizon is the default number of days', () => {
    const out = seriesOccurrences('2026-06-01', '1 day');
    assert.equal(out.length, SERIES_DEFAULT_HORIZON_DAYS + 1);
    assert.equal(out.at(-1), '2026-07-01');
  });

  test('an interval it cannot read is a one-off, not an error', () => {
    assert.deepEqual(seriesOccurrences('2026-06-01T08:00', 'fortnightly'), ['2026-06-01T08:00']);
    assert.deepEqual(seriesOccurrences('2026-06-01T08:00', '0 days'), ['2026-06-01T08:00']);
  });

  test('an until date before the first occurrence still keeps the first', () => {
    assert.deepEqual(seriesOccurrences('2026-06-10', '1 day', '2026-06-01'), ['2026-06-10']);
  });

  test('a tiny interval is capped rather than flooding the list', () => {
    assert.equal(seriesOccurrences('2026-06-01T00:00', '1 minute', '2026-06-30').length, 366);
  });
});

describe('isExpired', () => {
  const item = (due) => ({ due, scheduled_at: due });

  test('a timed item is expired from its moment', () => {
    assert.equal(isExpired(item('2026-06-01T10:00'), '2026-06-01T09:59:59'), false);
    assert.equal(isExpired(item('2026-06-01T10:00'), '2026-06-01T10:00:00'), true);
  });

  test('a date-only item is on time until 4am the next day', () => {
    assert.equal(isExpired(item('2026-06-30'), '2026-07-01T03:59:59'), false);
    assert.equal(isExpired(item('2026-06-30'), '2026-07-01T04:00:00'), true);
    assert.equal(isExpired(item('2026-12-31'), '2027-01-01T04:00:00'), true);
  });

  test('a snoozed item expires at its scheduled time, not its original due', () => {
    assert.equal(isExpired({ due: '2026-06-01T10:00', scheduled_at: '2026-06-01T12:00' }, '2026-06-01T11:00:00'), false);
  });

  test('an undated item never expires', () => {
    assert.equal(isExpired({ due: null, scheduled_at: null }, '2099-01-01T00:00:00'), false);
  });
});

describe('checkCompletedAt', () => {
  const ref = '2026-06-01T12:00:00';

  test('stores a stated local time verbatim, seconds filled in', () => {
    assert.deepEqual(checkCompletedAt('2026-06-01T10:15', ref), { ok: true, value: '2026-06-01T10:15:00' });
    assert.deepEqual(checkCompletedAt('2026-06-01 10:15:30', ref), { ok: true, value: '2026-06-01T10:15:30' });
    assert.deepEqual(checkCompletedAt('2026-05-31', ref), { ok: true, value: '2026-05-31' });
  });

  test('refuses a time carrying a zone rather than converting it', () => {
    assert.equal(checkCompletedAt('2026-06-01T10:15:00Z', ref).ok, false);
    assert.equal(checkCompletedAt('2026-06-01T10:15:00-04:00', ref).ok, false);
  });

  test('refuses dates and times that do not exist', () => {
    assert.equal(checkCompletedAt('2026-02-30T10:00', ref).ok, false);
    assert.equal(checkCompletedAt('2026-13-01', ref).ok, false);
    assert.equal(checkCompletedAt('2026-06-01T25:00', ref).ok, false);
    assert.equal(checkCompletedAt('', ref).ok, false);
  });

  test('refuses the future beyond two minutes of clock skew', () => {
    assert.equal(checkCompletedAt('2026-06-01T12:02', ref).ok, true);
    assert.equal(checkCompletedAt('2026-06-01T12:03', ref).ok, false);
    assert.equal(checkCompletedAt('2025-01-01T08:00', ref).ok, true);
  });
});

describe('lateness', () => {
  test('a timed item has 30 minutes of grace, then minutes, hours, days', () => {
    const done = (due, completed_at) => lateness({ due, completed_at });
    assert.equal(done('2026-06-01T10:00', '2026-06-01T10:30:00'), 'on time');
    assert.equal(done('2026-06-01T10:00', '2026-06-01T10:45:00'), '45 min late');
    assert.equal(done('2026-06-01T10:00', '2026-06-01T15:00:00'), '5h late');
    assert.equal(done('2026-06-01T10:00', '2026-06-04T10:00:00'), '3d late');
  });

  test('a date-only item is due at 4am the next day', () => {
    assert.equal(lateness({ due: '2026-06-01', completed_at: '2026-06-02T04:00:00' }), 'on time');
    assert.equal(lateness({ due: '2026-06-01', completed_at: '2026-06-02T05:00:00' }), '60 min late');
  });

  test('is wall-clock arithmetic, so a DST change adds no hour', () => {
    assert.equal(lateness({ due: '2026-11-01T00:30', completed_at: '2026-11-01T03:30:00' }), '3h late');
  });

  test('says nothing for an undated or unfinished item', () => {
    assert.equal(lateness({ due: null, completed_at: '2026-06-01T10:00:00' }), null);
    assert.equal(lateness({ due: '2026-06-01', completed_at: null }), null);
  });
});
