import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getClient } from './client.js';
import { ValidationError, uuid } from './helpers.js';

// Showing Jared an image: a mockup a session drew, a chart, a photo looked up for him.
//
// The image goes into the private `shared-images` bucket and the hub serves it at /img/<name> behind
// its login. The tool hands back a markdown image line; a reply carrying it is drawn inline by the
// hub's markdown renderer on the phone and by Markdown.swift on the watch, and a tap opens it full
// screen. A link outside the app (Safari, a text) reaches the hub's login page, not the picture.

export const BUCKET = 'shared-images';

const TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const EXT: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
};
const MAX_BYTES = 15 * 1024 * 1024;

/** The hub address the image is served from. Absolute, so the line is a working link anywhere it lands. */
export function hubBase(): string {
  return (process.env.HUB_URL || 'https://jared-status-hub.fly.dev').replace(/\/+$/, '');
}

/** `![caption](url)`, with the characters that would end either half taken out of the caption. */
export function imageMarkdown(name: string, caption: string): string {
  const alt = caption.replace(/[\[\]\n\r]+/g, ' ').trim();
  return `![${alt}](${hubBase()}/img/${name})`;
}

async function load(src: { path?: string; url?: string }): Promise<{ bytes: Buffer; type: string }> {
  if (src.path) {
    const type = TYPES[path.extname(src.path).toLowerCase()];
    if (!type) throw new ValidationError(`not an image file this can share (jpg, png, webp, gif — render an svg to png first): ${src.path}`);
    return { bytes: await readFile(src.path), type };
  }
  const url = String(src.url || '');
  if (!/^https?:\/\//i.test(url)) throw new ValidationError('give `path` (a file on this machine) or `url` (an http(s) image address)');
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new ValidationError(`fetching the image failed: HTTP ${r.status} from ${url}`);
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!EXT[type]) throw new ValidationError(`that address is not an image (it answered ${type || 'no content type'}); find the image's own address`);
  return { bytes: Buffer.from(await r.arrayBuffer()), type };
}

/** Upload one image → the markdown line that shows it. */
export async function shareImage(src: { path?: string; url?: string }, caption = ''): Promise<string> {
  const { bytes, type } = await load(src);
  if (!bytes.length) throw new ValidationError('the image is empty');
  if (bytes.length > MAX_BYTES) throw new ValidationError(`the image is ${(bytes.length / 1048576).toFixed(1)} MB; the limit is 15 MB — shrink it first`);
  const name = uuid() + EXT[type];
  const { error } = await getClient().storage.from(BUCKET).upload(name, bytes, { contentType: type, upsert: false });
  if (error) throw new Error(`could not store the image: ${error.message}`);
  return imageMarkdown(name, caption);
}
