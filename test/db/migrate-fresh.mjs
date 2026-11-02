// Build the test database's schema the way production got it: every migration, in order. Any
// migration that fails to apply fails the run, so a migration that only works on the live project is
// caught here.
//
// The one thing provided first is a stub of the `storage` schema, which belongs to Supabase's storage
// service rather than to Postgres; this image does not run it, and four migrations insert buckets
// and policies into it. The stub has only the columns those migrations use.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseUrl } from './db.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations');

async function connect() {
  // The image initialises itself and restarts Postgres once on first boot, so wait for a server that
  // has finished: one that answers and already has Supabase's roles.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const c = new pg.Client({ connectionString: databaseUrl() });
    try {
      await c.connect();
      const { rows } = await c.query("select 1 from pg_roles where rolname = 'service_role'");
      if (rows.length) return c;
      await c.end();
    } catch { await c.end().catch(() => {}); }
    if (Date.now() > deadline) throw new Error('test database did not come up');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const client = await connect();
const { rows } = await client.query("select to_regclass('public.desk_sessions') is not null as built");
if (rows[0].built) {
  console.error('migrate-fresh: the database already has the schema; it must be a fresh one');
  process.exit(1);
}
await client.query(`
  create schema if not exists storage;
  create table if not exists storage.buckets (
    id text primary key, name text not null, public boolean default false,
    file_size_limit bigint, allowed_mime_types text[]);
  create table if not exists storage.objects (
    id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);
`);
const failed = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  try { await client.query(readFileSync(join(dir, f), 'utf8')); }
  catch (e) { failed.push(`${f}: ${e.message}`); }
}
await client.end();
if (failed.length) {
  console.error(`migrate-fresh: ${failed.length} migrations did not apply:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
