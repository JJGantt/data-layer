import { getClient } from './client.js';
import { uuid } from './helpers.js';

// Dispatching work to a machine, and seeing what is already running there.
//
// The queue this writes into is drained by a consumer on the target machine (pi-desk on the Pi, the
// orchestrator on the Mac). Nothing here touches either machine directly — the hub runs on Fly and
// this MCP runs wherever it runs, so Supabase carries both directions.

export type Machine = 'pi' | 'mac';

export interface DeskSession {
  id: string; worker: string; repo: string; status: string;
  prompt: string | null; last_reply: string | null;
  claude_session_id: string | null; started: string; last_seen: string;
}

/** Repos a machine has published. The path is never taken from a caller — only ever selected. */
export async function knownRepo(name: string): Promise<{ path: string; name: string } | null> {
  const { data } = await getClient().from('repos').select('path,name');
  const want = String(name || '').trim().toLowerCase();
  // Exact first, then a unique prefix, so "status" finds status-hub but an ambiguous stem does not
  // silently pick one at random.
  const exact = (data ?? []).find((r) => String(r.name).toLowerCase() === want);
  if (exact) return { path: exact.path, name: exact.name };
  const hits = (data ?? []).filter((r) => String(r.name).toLowerCase().startsWith(want));
  return hits.length === 1 ? { path: hits[0].path, name: hits[0].name } : null;
}

/**
 * Send work to a machine.
 *
 * `machine` defaults to the Pi on purpose: a session started by voice is meant to outlive the
 * conversation that started it, and the Mac sleeps. Choose 'mac' when the work wants the Mac
 * specifically — iOS, where compiling locally is the whole advantage.
 */
export async function startSession(repo: string, prompt: string, machine: Machine = 'pi') {
  const hit = await knownRepo(repo);
  if (!hit) return { ok: false as const, error: `no repo matching '${repo}'` };
  const id = uuid();
  const { error } = await getClient().from('desk_commands').insert({
    id, kind: 'open_session',
    payload: { path: hit.path, name: hit.name, target: machine, ...(prompt ? { prompt } : {}) },
  });
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, id, repo: hit.name, machine };
}

export async function listSessions(): Promise<DeskSession[]> {
  const { data } = await getClient().from('desk_sessions').select('*').order('last_seen', { ascending: false });
  return (data ?? []) as DeskSession[];
}

export async function queued() {
  const { data } = await getClient().from('desk_queue').select('*').is('claimed', null).order('created');
  return data ?? [];
}

/** Resume an evicted session with its full context, or end a running one. */
export async function sessionCommand(kind: 'resume_session' | 'end_session', session: string, prompt?: string) {
  const id = uuid();
  const { error } = await getClient().from('desk_commands').insert({
    id, kind, payload: { session, target: 'pi', ...(prompt ? { prompt } : {}) },
  });
  return error ? { ok: false as const, error: error.message } : { ok: true as const, id };
}

export function formatSessions(rows: DeskSession[], q: any[]): string {
  if (!rows.length && !q.length) return 'No sessions running or parked.';
  const lines: string[] = [];
  const res = rows.filter((r) => r.status === 'resident');
  const ev = rows.filter((r) => r.status === 'evicted');
  if (res.length) {
    lines.push(`**Running** (${res.length}):`);
    for (const r of res) lines.push(`- ${r.repo} — ${(r.last_reply || r.prompt || 'no output yet').slice(0, 100)}  [${r.id}]`);
  }
  if (ev.length) {
    lines.push(`**Parked** (${ev.length}, resumable with full context):`);
    for (const r of ev) lines.push(`- ${r.repo} — ${(r.last_reply || r.prompt || '').slice(0, 100)}  [${r.id}]`);
  }
  if (q.length) {
    lines.push(`**Queued** (${q.length}, waiting for a slot):`);
    for (const r of q) lines.push(`- ${r.repo} — ${(r.prompt || '').slice(0, 80)}`);
  }
  return lines.join('\n');
}
