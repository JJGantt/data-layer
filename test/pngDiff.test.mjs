// What a handoff treats as "the screen changed" before it acts on a tap (src/pngDiff.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { decodePng, diffFraction } from '../dist/pngDiff.js';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** An RGBA PNG whose pixel (x, y) is paint(x, y) → [r, g, b], each row with filter `filter`. */
function png(w, h, paint, filter = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  let prev = Buffer.alloc(w * 4);
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(w * 4);
    for (let x = 0; x < w; x++) { const [r, g, b] = paint(x, y); row.set([r, g, b, 255], x * 4); }
    const out = Buffer.alloc(w * 4);
    for (let i = 0; i < row.length; i++) out[i] = filter === 2 ? (row[i] - prev[i]) & 0xff : row[i];
    rows.push(Buffer.from([filter]), out);
    prev = row;
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const page = (x, y) => (y < 20 ? [200, 30, 30] : x % 10 < 5 ? [240, 240, 240] : [30, 30, 30]);

test('decodes filtered rows to the pixels that were painted', () => {
  const p = decodePng(png(40, 40, page, 2));
  assert.equal(p.width, 40);
  assert.deepEqual([...p.data.subarray(0, 3)], [200, 30, 30]);
  assert.deepEqual([...p.data.subarray((30 * 40 + 7) * 4, (30 * 40 + 7) * 4 + 3)], [30, 30, 30]);
});

test('the same screen is no change, whatever filter encoded it', () => {
  assert.equal(diffFraction(png(40, 40, page, 0), png(40, 40, page, 2)), 0);
});

test('a caret blinking in a field is a tiny change', () => {
  const caret = (x, y) => (x === 20 && y > 25 && y < 32 ? [0, 0, 0] : page(x, y));
  assert.ok(diffFraction(png(40, 40, page), png(40, 40, caret)) < 0.05);
});

test('a scrolled page is a large change', () => {
  const scrolled = (x, y) => page(x, y + 15);
  assert.ok(diffFraction(png(40, 40, page), png(40, 40, scrolled)) > 0.05);
});

test('screenshots of different sizes, or not PNGs at all, count as entirely changed', () => {
  assert.equal(diffFraction(png(40, 40, page), png(40, 30, page)), 1);
  assert.equal(diffFraction(png(40, 40, page), Buffer.from('not a png')), 1);
});
