import { readFileSync } from 'node:fs';
import { ValidationError } from './helpers.js';
import * as lists from './lists.js';

// Saving the audio of the command being answered onto a list item: a song idea played into the phone
// or the watch. The cut, the storage and the playback are the hub's (status-hub /api/list-recordings);
// this only says which command and which item.
//
// Which command: the voice worker writes the in-flight request's id to the file DATA_REQ_FILE names,
// re-read on every call, for the same reason DATA_TS_FILE is a file (helpers.ts now()): this server runs
// warm for the worker's whole life, so a value in its environment would be the first command's for ever.

function currentRequest(): string | null {
  const f = process.env.DATA_REQ_FILE;
  if (!f) return null;
  try { return readFileSync(f, 'utf8').trim() || null; } catch { return null; }
}

export interface SaveOpts { after?: string; start_s?: number }

/** → a line for the model saying what was saved, or what to do instead. */
export async function saveRecording(itemPrefix: string, listId: string | null, opts: SaveOpts): Promise<string> {
  const requestId = currentRequest();
  if (!requestId) throw new ValidationError('there is no voice command in flight to take a recording from — this only works on a spoken command from the phone or the watch');
  const hub = process.env.HUB_URL || 'https://jared-status-hub.fly.dev';
  const token = process.env.HUB_TOKEN;
  if (!token) throw new Error('HUB_TOKEN is not set for the data server, so it cannot reach the hub');
  const id = await lists.resolveListItemId(listId, itemPrefix);
  if (!id) return `No item matched id '${itemPrefix}'${listId ? ` on '${listId}'` : ''}.`;
  const body: Record<string, unknown> = { request_id: requestId, item_id: id };
  if (opts.start_s != null) body.start_s = Number(opts.start_s);
  else if (opts.after) body.after = String(opts.after);
  const r = await fetch(`${hub}/api/list-recordings`, {
    method: 'POST', headers: { 'X-Hub-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
  });
  const out: any = await r.json().catch(() => ({}));
  if (r.status === 422) {
    return `Nothing saved: ${out.error}. The recording's words with their start times (seconds) are below — `
      + `call again with \`start_s\` set to the END of the marker word (the next word's time), not \`after\`:\n${out.words}`;
  }
  if (!r.ok) throw new Error(`hub could not save the recording (${r.status}): ${out.error || 'no detail'}`);
  const rec = out.recording || {};
  const len = rec.dur ? `${Math.round(rec.dur)}s` : 'a';
  const starts = out.starts_with ? ` It starts: "${out.starts_with}…"` : '';
  return `Saved ${len} recording (cut at ${rec.start_s}s) — the item now holds ${out.count}.${starts}`;
}
