// The disposable database the SQL tests run against (bin/test-db makes one). Each test runs inside a
// transaction that is always rolled back, so tests cannot see each other's rows.
import pg from 'pg';

export function databaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set; run the SQL tests with `npm run test:db`');
  // These tests delete whole tables inside their transactions. A rollback undoes that, but nothing
  // here should ever be pointed at a database that matters, so only a local one is accepted.
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1', 'postgres'].includes(host)) {
    throw new Error(`TEST_DATABASE_URL must be a local disposable database, not ${host}`);
  }
  return url;
}

export async function withRollback(fn) {
  const client = new pg.Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query('begin');
    return await fn(client);
  } finally {
    await client.query('rollback').catch(() => {});
    await client.end();
  }
}
