// Dump every table in the Supabase project to newline-delimited JSON, one file per table, into a
// dated tarball on this machine.
//
// Why this and not pg_dump: neither machine has pg_dump, and `supabase db dump` goes through the
// pooler and hangs here. PostgREST needs nothing but the service key that is already on disk.
//
// What this does NOT capture is schema — no DDL, no policies, no functions. That is deliberate:
// the schema is supabase/migrations/, which is in git and therefore already backed up better than
// a tarball could. A restore is `supabase db push` followed by loading these rows. Anything that
// exists only in the dashboard and never in a migration is NOT covered by this.
//
// Usage: SUPABASE_URL=... SUPABASE_KEY=... node backup.mjs <outdir>

import { mkdir, writeFile, rm, readdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
const exec = promisify(execFile);

const URL_ = process.env.SUPABASE_URL;
const KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;
const OUT  = process.argv[2] || path.join(process.env.HOME, 'supabase-backups');
if (!URL_ || !KEY) { console.error('need SUPABASE_URL and SUPABASE_KEY'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// It runs before dawn on a Mac that is usually asleep, so it often starts in a dark wake before the network
// is steady. A dropped connection or a 5xx is retried with backoff rather than failing the night.
async function fetchRetry(url, opts) {
  const waits = [2000, 5000, 15000, 30000];
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status < 500 || i >= waits.length) return res;
      console.warn(`  ${url}: HTTP ${res.status} (will retry)`);
    } catch (e) {
      if (i >= waits.length) throw e;
      console.warn(`  ${url}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ''} (will retry)`);
    }
    await new Promise(r => setTimeout(r, waits[i]));
  }
}

const stamp = new Date().toISOString().slice(0, 10);
const work  = path.join(OUT, `.work-${stamp}`);
await mkdir(work, { recursive: true });

// The OpenAPI root lists exactly what the service key can read.
const spec = await (await fetchRetry(`${URL_}/rest/v1/`, { headers: H })).json();
const tables = Object.keys(spec.paths || {})
  .filter(p => p !== '/' && !p.includes('{') && !p.startsWith('/rpc/'))
  .map(p => p.slice(1)).sort();

// Each table is paged by its primary key: the next page is the rows after the last key seen, which the
// database answers from the index. Paging by offset instead makes page N re-read the N*1000 rows before
// it, so a table of millions costs billions of row reads and drains the database's disk I/O budget.
// A table with no primary key is small and paged by offset.
const pkOf = (t) => Object.entries(spec.definitions?.[t]?.properties || {})
  .filter(([, p]) => (p.description || '').includes('<pk/>')).map(([c]) => c);
const lit = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// Rows strictly after `last` in (c1, c2, ...) order, as a PostgREST `or` filter.
const after = (pk, last) => 'or=' + encodeURIComponent(`(${pk.map((c, i) => {
  const eqs = pk.slice(0, i).map((p) => `${p}.eq.${lit(last[p])}`);
  const gt = `${c}.gt.${lit(last[c])}`;
  return eqs.length ? `and(${[...eqs, gt].join(',')})` : gt;
}).join(',')})`);

let totalRows = 0; const summary = [];
for (const t of tables) {
  const lines = [];
  const pk = pkOf(t);
  let last = null;
  for (let from = 0; ; from += 1000) {
    const q = pk.length
      ? `${URL_}/rest/v1/${t}?select=*&order=${pk.map((c) => `${c}.asc`).join(',')}&limit=1000`
        + (last ? `&${after(pk, last)}` : '')
      : `${URL_}/rest/v1/${t}?select=*&limit=1000&offset=${from}`;
    const res = await fetchRetry(q, { headers: H });
    // A table cut short would look complete in the archive, so any failure fails the whole backup.
    if (!res.ok) throw new Error(`${t}: HTTP ${res.status} ${await res.text()}`);
    const batch = await res.json();
    if (!Array.isArray(batch)) break;
    for (const r of batch) lines.push(JSON.stringify(r));
    if (batch.length < 1000) break;
    last = batch[batch.length - 1];
  }
  await writeFile(path.join(work, `${t}.jsonl`), lines.join('\n') + (lines.length ? '\n' : ''));
  totalRows += lines.length; summary.push(`${t}\t${lines.length}`);
}
await writeFile(path.join(work, '_manifest.txt'),
  `supabase backup ${new Date().toISOString()}\nproject ${URL_}\n${tables.length} tables, ${totalRows} rows\n\n`
  + summary.join('\n') + '\n');

const tmp = path.join(OUT, `.tmp-${stamp}.tar.gz`);
const final = path.join(OUT, `supabase-${stamp}.tar.gz`);
await exec('tar', ['czf', tmp, '-C', work, '.']);
// Prove the archive before it replaces anything — a truncated tarball that is never opened until
// it is needed is worse than no backup, because it stops anyone looking for one.
await exec('tar', ['tzf', tmp]);
await exec('mv', [tmp, final]);
await rm(work, { recursive: true, force: true });
const sz = (await stat(final)).size;
console.log(`${tables.length} tables, ${totalRows} rows -> ${final} (${(sz/1048576).toFixed(1)} MB)`);

// Retention: every 1st-of-month kept forever, plus the last 14 of anything else. At a few MB a
// dump, that is ~50MB/year retained permanently, which is the point of the exercise.
const keep = 14;
const all = (await readdir(OUT)).filter(f => /^supabase-\d{4}-\d\d-\d\d\.tar\.gz$/.test(f)).sort();
const monthly = new Set(all.filter(f => f.endsWith('-01.tar.gz')));
const rest = all.filter(f => !monthly.has(f));
for (const f of rest.slice(0, Math.max(0, rest.length - keep))) {
  await rm(path.join(OUT, f)); console.log(`  pruned ${f}`);
}
console.log(`retained: ${monthly.size} monthly + ${Math.min(rest.length, keep)} recent`);
