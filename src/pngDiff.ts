/**
 * Screenshot pixels: how much two differ — what a handoff checks before it acts on a tap or typing, so a tap
 * made on a picture of the screen never lands on a screen that has since changed under it (handoffAgent.ts).
 *
 * Decodes only what the handoff screenshots are: 8-bit, non-interlaced RGB or RGBA PNG (macOS
 * screencapture, Chrome's CDP capture). Anything else is reported as undecodable, not guessed at.
 */
import { deflateSync, inflateSync } from 'node:zlib';

export type Pixels = { width: number; height: number; channels: number; data: Buffer };

export function decodePng(png: Buffer): Pixels | null {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, width = 0, height = 0, channels = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= png.length) {
    const len = png.readUInt32BE(off), type = png.toString('ascii', off + 4, off + 8);
    const body = png.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return null;
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!width || !channels || !idat.length) return null;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? out[dst + i - channels] : 0;
      const b = y > 0 ? out[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? out[dst - stride + i - channels] : 0;
      let v: number;
      if (f === 0) v = x;
      else if (f === 1) v = x + a;
      else if (f === 2) v = x + b;
      else if (f === 3) v = x + ((a + b) >> 1);
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else return null;
      out[dst + i] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * The fraction of pixels (0-1) that visibly differ between two screenshots; 1 when their sizes differ
 * or either cannot be decoded, since then nothing says they show the same thing. A pixel differs when
 * its R, G and B together move by more than `threshold`, so compression noise and anti-aliasing do not
 * count; a blinking caret or a small animation counts only as the handful of pixels it is.
 */
export function diffFraction(a: Buffer, b: Buffer, threshold = 48): number {
  const pa = decodePng(a), pb = decodePng(b);
  if (!pa || !pb || pa.width !== pb.width || pa.height !== pb.height) return 1;
  let changed = 0, seen = 0;
  for (let y = 0; y < pa.height; y += 2) {
    for (let x = 0; x < pa.width; x += 2) {
      const ia = (y * pa.width + x) * pa.channels, ib = (y * pb.width + x) * pb.channels;
      const d = Math.abs(pa.data[ia] - pb.data[ib]) + Math.abs(pa.data[ia + 1] - pb.data[ib + 1]) + Math.abs(pa.data[ia + 2] - pb.data[ib + 2]);
      if (d > threshold) changed++;
      seen++;
    }
  }
  return seen ? changed / seen : 0;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
  return Buffer.concat([len, tb, crc]);
}

/** Pixels as an 8-bit RGB/RGBA PNG (rows unfiltered; a screenshot crop, not an archive). */
export function encodePng(p: Pixels): Buffer {
  const stride = p.width * p.channels;
  const raw = Buffer.alloc((stride + 1) * p.height);
  for (let y = 0; y < p.height; y++) p.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(p.width, 0); ihdr.writeUInt32BE(p.height, 4);
  ihdr[8] = 8; ihdr[9] = p.channels === 4 ? 6 : 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** The part of a screenshot inside `f` (fractions of it), as its own PNG; null when it cannot be decoded. */
export function cropPng(png: Buffer, f: { x: number; y: number; w: number; h: number }): Buffer | null {
  const p = decodePng(png);
  if (!p) return null;
  const x0 = Math.round(f.x * p.width), y0 = Math.round(f.y * p.height);
  const w = Math.max(1, Math.min(p.width - x0, Math.round(f.w * p.width)));
  const h = Math.max(1, Math.min(p.height - y0, Math.round(f.h * p.height)));
  const out = Buffer.alloc(w * h * p.channels);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * p.width + x0) * p.channels;
    p.data.copy(out, y * w * p.channels, src, src + w * p.channels);
  }
  return encodePng({ width: w, height: h, channels: p.channels, data: out });
}
