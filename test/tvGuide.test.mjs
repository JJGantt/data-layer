// The TV Guide's shelves: what an item opens in, and where a new or moved row lands.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveItem, positionsAt, cleanNote } from '../dist/tvGuide.js';

describe('resolveItem', () => {
  test('a YouTube URL opens in the YouTube app with its thumbnail derived', () => {
    assert.deepEqual(resolveItem({ title: ' Quantum ', url: 'https://www.youtube.com/watch?v=KfODG5REyss' }), {
      title: 'Quantum', url: 'https://www.youtube.com/watch?v=KfODG5REyss',
      package: 'com.google.android.youtube.tv', image: 'https://i.ytimg.com/vi/KfODG5REyss/hqdefault.jpg', note: null });
    assert.equal(resolveItem({ title: 'x', url: 'https://youtu.be/KfODG5REyss' }).package, 'com.google.android.youtube.tv');
  });

  test('an intent link names its own package, and a given image is kept', () => {
    const r = resolveItem({ title: 'Reacher', image: 'https://img/r.jpg',
      url: 'intent://watch.amazon.com/watch?asin=B09P4BWY8H#Intent;package=com.amazon.amazonvideo.livingroom;scheme=https;end' });
    assert.equal(r.package, 'com.amazon.amazonvideo.livingroom');
    assert.equal(r.image, 'https://img/r.jpg');
  });

  test('an intent link without a package and with no app has none', () => {
    assert.equal(resolveItem({ title: 'x', url: 'intent://tv.apple.com/us/show/x#Intent;scheme=https;end' }).package, null);
    assert.equal(resolveItem({ title: 'x', app: 'appletv', url: 'intent://tv.apple.com/us/show/x#Intent;scheme=https;end' }).package,
      'com.apple.atve.androidtv.appletv');
  });

  test('refuses an item with no title, no url, or an unknown app', () => {
    assert.throws(() => resolveItem({ title: '', url: 'https://youtu.be/KfODG5REyss' }));
    assert.throws(() => resolveItem({ title: 'x', url: '' }));
    assert.throws(() => resolveItem({ title: 'x', url: 'https://youtu.be/KfODG5REyss', app: 'nope' }));
  });
});

describe('cleanNote', () => {
  test('trims, and blank or missing means no note', () => {
    assert.equal(cleanNote(' 93% '), '93%');
    assert.equal(cleanNote('   '), null);
    assert.equal(cleanNote(undefined), null);
    assert.equal(cleanNote(null), null);
  });
  test('an item carries its note through resolveItem', () => {
    assert.equal(resolveItem({ title: 'x', url: 'https://youtu.be/KfODG5REyss', note: ' 4h 20m' }).note, '4h 20m');
  });
});

describe('positionsAt', () => {
  const rows = [{ id: 'a', position: 1 }, { id: 'b', position: 2 }, { id: 'c', position: 3 }];
  const sorted = (xs) => xs.every((x, i) => i === 0 || xs[i - 1] < x);

  test('an empty shelf numbers from 1', () => assert.deepEqual(positionsAt([], 3), [1, 2, 3]));

  test('appends after the last row when no position is given, or one past the end', () => {
    assert.deepEqual(positionsAt(rows, 2), [4, 5]);
    assert.deepEqual(positionsAt(rows, 1, 99), [4]);
  });

  test('position 1 lands before the first row, in order', () => {
    const p = positionsAt(rows, 2, 1);
    assert.ok(sorted([...p, 1]));
  });

  test('a middle position lands strictly between its neighbours', () => {
    const p = positionsAt(rows, 3, 2);
    assert.ok(sorted([1, ...p, 2]));
  });
});
