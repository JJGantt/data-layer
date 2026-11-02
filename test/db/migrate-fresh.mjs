// Build the test database's schema the way production got it: every migration, in order.
//
// A few migrations touch objects the live project has but no migration creates (tables made in the
// Supabase dashboard, and the `storage` schema, which belongs to a service this image does not run).
// Those files fail here and are listed on stderr; the tests then fail on anything they actually need.
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
const failed = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  try { await client.query(readFileSync(join(dir, f), 'utf8')); }
  catch (e) { failed.push(`${f}: ${e.message}`); }
}
await client.end();
if (failed.length) console.error(`migrate-fresh: ${failed.length} migrations did not apply here:\n  ${failed.join('\n  ')}`);
