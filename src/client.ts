import { createClient, SupabaseClient } from '@supabase/supabase-js';
import ws from 'ws';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The service_role key is NOT in this file. It bypasses RLS entirely — full read/write on every
// table — so a copy in source is a copy in every clone, every fork, and every commit anyone can read.
//
// It comes from the environment. For callers that set it themselves (the Fly app via secrets, the
// worker via its own .env, the MCP via its launch config) nothing changes. For everything else,
// this reads the gitignored .env beside the package, so `node -e` one-liners and local scripts keep
// working without exporting anything by hand.
function loadDotEnv(): void {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/client.js at runtime, src/client.ts under ts-node — .env sits one level up from either.
    for (const p of [join(here, '..', '.env'), join(here, '..', '..', '.env')]) {
      let text: string;
      try { text = readFileSync(p, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq < 1) continue;
        const k = t.slice(0, eq).trim();
        // Never clobber a value the caller set deliberately.
        if (!(k in process.env)) process.env[k] = t.slice(eq + 1).trim();
      }
      return;
    }
  } catch { /* no .env is fine when the environment already carries the values */ }
}
loadDotEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://felyggqjjhltwokdfhop.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

let _client: SupabaseClient | null = null;

export function getClient(): SupabaseClient {
  if (!SUPABASE_KEY) {
    // Fail loudly rather than constructing a client that 401s on every call and looks like a
    // network problem.
    throw new Error(
      'SUPABASE_KEY is not set. Put it in data-layer/.env (gitignored) or export it before running.',
    );
  }
  if (!_client) _client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws as any },
  });
  return _client;
}
