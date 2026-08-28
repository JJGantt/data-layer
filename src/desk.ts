import { getClient } from './client.js';
import { uuid } from './helpers.js';

// Dispatching work to a machine, and seeing what is already running there.
//
// The queue this writes into is drained by a consumer on the target machine (pi-desk on the Pi, the
// orchestrator on the Mac). Nothing here touches either machine directly — the hub runs on Fly and
// this MCP runs wherever it runs, so Supabase carries both directions.

export type Machine = 'pi' | 'mac';

/** The worker each machine's desk consumer heartbeats as. */
const DESK_WORKER: Record<Machine, string> = { pi: 'pi-desk', mac: 'desk' };
// Same 90s the hub and pi-desk use: three missed 30s beats.
const DESK_STALE_S = 90;

/**
 * Is the machine that would run this actually there?
 *
 * Checked BEFORE a command is written, because the queue has no way to fail: a command for a machine
 * that is asleep is claimed by nobody, expires unread, and the caller was already told it started.
 */
export async function machineAwake(machine: Machine): Promise<boolean> {
  const { data } = await getClient().from('worker_presence')
    .select('last_seen').eq('worker', DESK_WORKER[machine]).maybeSingle();
  const t = data?.last_seen;
  return !!t && (Date.now() - new Date(t).getTime()) / 1000 <= DESK_STALE_S;
}

/**
 * Keep a command that could not run.
 *
 * A dispatched prompt is usually minutes of dictated speech that cannot be said again the same way,
 * so nothing is ever dropped — it is parked here with the reason, and retried later only if Jared
 * still wants it. Deliberately not a retry queue: see the migration.
 */
export async function deadLetter(
  kind: string, payload: any, machine: Machine | null, reason: string,
  source = 'dispatch', commandId: string | null = null,
): Promise<string | null> {
  const id = uuid();
  const { error } = await getClient().from('desk_dead_letters')
    .insert({ id, command_id: commandId, kind, payload, machine, reason, source });
  // A failure to record a failure is the one case with nothing left to fall back on — say so in the
  // log rather than swallowing it, and still return the caller an honest null.
  if (error) { console.error('[desk] dead letter:', error.message); return null; }
  return id;
}

/** Failed commands not yet retried or dismissed, newest first. */
export async function deadLetters(includeClosed = false) {
  let q = getClient().from('desk_dead_letters').select('*').order('created', { ascending: false }).limit(50);
  if (!includeClosed) q = q.is('retried', null).is('dismissed', null);
  const { data } = await q;
  return data ?? [];
}

/** Re-dispatch a saved command, unchanged, if its machine is up now. */
export async function retryDeadLetter(id: string) {
  const { data: row } = await getClient().from('desk_dead_letters').select('*').eq('id', id).maybeSingle();
  if (!row) return { ok: false as const, error: 'no such saved command' };
  if (row.retried) return { ok: false as const, error: 'already retried' };
  const machine = (row.machine === 'mac' ? 'mac' : 'pi') as Machine;
  if (!(await machineAwake(machine))) {
    return { ok: false as const, error: `the ${machine === 'mac' ? 'Mac' : 'Pi'} is still not responding — leaving it saved` };
  }
  const cmdId = uuid();
  const { error } = await getClient().from('desk_commands')
    .insert({ id: cmdId, kind: row.kind, payload: { ...row.payload, target: machine } });
  if (error) return { ok: false as const, error: error.message };
  await getClient().from('desk_dead_letters')
    .update({ retried: new Date().toISOString(), retry_command_id: cmdId }).eq('id', id);
  // A re-sent dispatch is the thing being talked to again, exactly as a fresh one would be.
  if (row.kind === 'open_session' || row.kind === 'resume_session') await setFocus(cmdId, machine);
  return { ok: true as const, id: cmdId };
}

/** Drop one for good — it was not worth doing after all. */
export async function dismissDeadLetter(id: string) {
  const { error } = await getClient().from('desk_dead_letters')
    .update({ dismissed: new Date().toISOString() }).eq('id', id);
  return error ? { ok: false as const, error: error.message } : { ok: true as const };
}

export interface DeskSession {
  id: string; worker: string; repo: string; status: string;
  prompt: string | null; last_reply: string | null;
  // last_reply is the FINAL message of a turn when `working` is false, and the previous turn's
  // answer while a new one is in flight. reply_at is when that text landed.
  working: boolean; reply_at: string | null;
  claude_session_id: string | null; started: string; last_seen: string;
}

/** Every project a machine has published, most recently touched first. */
export async function listRepos(): Promise<{ name: string; branch: string | null; last_active: string | null }[]> {
  const { data } = await getClient().from('repos')
    .select('name,branch,last_active').order('last_active', { ascending: false, nullsFirst: false });
  return (data ?? []) as any;
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
export async function startSession(repo: string | undefined, prompt: string, machine: Machine = 'pi', report = false, label?: string) {
  // No repo named, or one that matches nothing, lands in the home directory. A request the router
  // could not pin to a project still gets sent somewhere it can act — refusing it would be worse,
  // and the session can find its own way from there.
  const want = String(repo || '').trim();
  const hit = want && want.toLowerCase() !== 'root' ? await knownRepo(want) : null;
  const target = hit ?? { path: '~', name: 'root' };
  const id = uuid();
  // `report` is opt-in and only ever set when Jared asked for a write-up. The launchers append
  // their report directive on this flag alone, so an ordinary dispatch stays a plain session.
  const payload = { path: target.path, name: target.name, target: machine, ...(prompt ? { prompt } : {}), ...(report ? { report: true } : {}), ...(label ? { label: label.slice(0, 60) } : {}) };
  // The machine has to be there NOW. Writing the command anyway is the silent failure this guards:
  // nobody claims it, it expires unread, and the reply already said a session had started.
  if (!(await machineAwake(machine))) {
    const saved = await deadLetter('open_session', payload, machine, `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`);
    return { ok: false as const, machine, saved,
             error: `The ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding, so nothing was started. The prompt is saved and can be retried.` };
  }
  const { error } = await getClient().from('desk_commands').insert({ id, kind: 'open_session', payload });
  if (error) return { ok: false as const, error: error.message };
  await setFocus(id, machine);
  return { ok: true as const, id, repo: target.name, machine, matched: !!hit || !want };
}

/**
 * Point follow-ups at the dispatch just made.
 *
 * Moved ONLY from here and from resume — never from anything a human does at a keyboard. Jared may be
 * working in another session at the same moment, and "the most recently active session" would send a
 * dictated follow-up straight into it. The pointer belongs to the assistant's own dispatches.
 *
 * A command id, not a session id: at this moment the session does not exist yet. The machine creates
 * it a moment later and records command_id on the row, which is what resolves the two.
 */
export async function setFocus(commandId: string, machine: Machine) {
  await getClient().from('desk_focus')
    .upsert({ id: 'current', command_id: commandId, session_id: null, machine, updated: new Date().toISOString() },
            { onConflict: 'id' });
}

/**
 * The session a follow-up should go to.
 *
 * Two ways it can be set, and `session_id` wins because it is the deliberate one: Jared naming a
 * session he wants to talk to. `command_id` is the automatic one — the dispatch just made — and is
 * how the pointer moves when he starts work rather than chooses it.
 */
export async function focusedSession(): Promise<DeskSession | null> {
  const { data: f } = await getClient().from('desk_focus').select('*').eq('id', 'current').maybeSingle();
  if (f?.session_id) {
    const { data } = await getClient().from('desk_sessions').select('*').eq('id', f.session_id).maybeSingle();
    return (data as DeskSession) ?? null;
  }
  if (!f?.command_id) return null;
  const { data } = await getClient().from('desk_sessions').select('*').eq('command_id', f.command_id).maybeSingle();
  return (data as DeskSession) ?? null;
}

/**
 * Point at a session that already exists, so what he says next goes there.
 *
 * This is the half the pointer was missing. It only ever moved to the LAST THING DISPATCHED, which is
 * fine while starting work and useless for going back to something — on a wall or a watch there is no
 * other way to say which of five sessions he means.
 *
 * Still never automatic: choosing is an act, and the reason the pointer ignores "the most recently
 * active session" is that Jared is usually typing in one of those.
 */
export async function focusSession(ref: string) {
  const found = await resolveSession(ref);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  if (row.status !== 'resident') {
    return { ok: false as const, error: `that session is not running — resume it first` };
  }
  const machine: Machine = row.worker === 'desk' ? 'mac' : 'pi';
  await getClient().from('desk_focus').upsert(
    { id: 'current', session_id: row.id, command_id: null, machine, updated: new Date().toISOString() },
    { onConflict: 'id' });
  return { ok: true as const, session: row.id, repo: row.repo, label: (row as any).label ?? null, machine };
}

/**
 * Send a follow-up into the focused session.
 *
 * Resolution can legitimately fail two ways, and they mean different things: nothing has been
 * dispatched yet, or the dispatch has not become a session yet (a launch takes a few seconds). Saying
 * which one saves Jared guessing whether it worked.
 */
export async function followUp(prompt: string) {
  const { data: f } = await getClient().from('desk_focus').select('*').eq('id', 'current').maybeSingle();
  // EITHER pointer counts. `command_id` is the dispatch just made; `session_id` is a session focused
  // deliberately, and focusing CLEARS command_id — so gating on command_id alone made every follow-up
  // after a focus fail with "no session has been started from here yet", while the reply claimed it
  // had been sent. Three rounds of prompt-wording chased that before it turned out to be this line.
  if (!f?.command_id && !f?.session_id) {
    return { ok: false as const, error: 'no session has been started or focused from here yet' };
  }
  const machine = (f.machine === 'mac' ? 'mac' : 'pi') as Machine;
  const s = await focusedSession();
  // Nothing to type into. Both cases lose the words unless they are kept: the session has not opened
  // yet, or it has since ended — which the machines now report accurately, so this is reachable.
  if (!s || s.status !== 'resident') {
    const reason = !s ? 'the last dispatch has not opened its session yet' : 'the session it was aimed at has ended';
    const saved = await deadLetter('follow_up', { session: s?.id ?? null, prompt, target: machine }, machine, reason);
    return { ok: false as const, saved, error: `${reason} — nothing was sent. The follow-up is saved and can be retried.` };
  }
  if (!(await machineAwake(machine))) {
    const saved = await deadLetter('follow_up', { session: s.id, prompt, target: machine }, machine,
                                   `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`);
    return { ok: false as const, saved,
             error: `The ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding, so the follow-up was not sent. It is saved and can be retried.` };
  }
  const id = uuid();
  const { error } = await getClient().from('desk_commands').insert({
    id, kind: 'follow_up', payload: { session: s.id, prompt, target: machine },
  });
  return error ? { ok: false as const, error: error.message } : { ok: true as const, id, repo: s.repo, session: s.id };
}

/**
 * Sessions with a NUMBER, which is how they get talked about out loud.
 *
 * **1 is the newest.** Only ACTIVE sessions (resident or evicted) are numbered, so the list is
 * always 1..N over what is actually there.
 *
 * ORDERED BY `started`, WHICH NEVER CHANGES. Ordering by `last_seen` was the obvious reading of "most
 * recent" and it made the numbers unusable: every row is touched by its reconcile tick every 30s, so
 * the order reshuffled between two reads seconds apart — measured, with two sessions sharing a
 * timestamp to the second. A number said out loud has to still mean the same session by the time it
 * is resolved, and a spoken command is several seconds of speech plus a model turn.
 *
 * The number is a POSITION, not identity: it belongs to the list, not to the session, and closing one
 * renumbers the rest. Numbers that stick to a session drift upward for ever and you end up saying
 * "session eleven" to name one of four things on screen.
 *
 * The hub's `/api/sessions` implements the identical rule; the two have to agree or the pane and the
 * voice tools disagree about which session is which.
 */
export function numberSessions(rows: DeskSession[]): (DeskSession & { n: number })[] {
  return rows
    .filter((r) => r.status === 'resident' || r.status === 'evicted')
    .sort((a, b) => new Date(b.started).getTime() - new Date(a.started).getTime())
    .map((r, i) => ({ ...r, n: i + 1 }));
}

export async function listSessions(): Promise<DeskSession[]> {
  const { data } = await getClient().from('desk_sessions').select('*').order('last_seen', { ascending: false });
  return (data ?? []) as DeskSession[];
}

/**
 * Find the session someone named — by number ("session three"), by repo or label, or by full id.
 *
 * An ambiguous name is answered with the choices rather than a guess: picking one of three status-hub
 * sessions at random and then ending or moving it is not a recoverable mistake.
 */
export async function resolveSession(ref: string): Promise<
  { ok: true; row: DeskSession & { n: number } } | { ok: false; error: string }> {
  const want = String(ref || '').trim();
  if (!want) return { ok: false, error: 'which session?' };
  const rows = numberSessions(await listSessions());
  if (!rows.length) return { ok: false, error: 'no sessions are running or parked' };

  const low = want.toLowerCase();
  if (/^\d+$/.test(want)) {
    const hit = rows.find((r) => r.n === Number(want));
    return hit ? { ok: true, row: hit }
               : { ok: false, error: `there is no session ${want} — there are ${rows.length}` };
  }
  const exact = rows.find((r) => r.id === want);
  if (exact) return { ok: true, row: exact };

  const matches = (r: DeskSession & { n: number }) =>
    String(r.repo || '').toLowerCase().startsWith(low)
    || String((r as any).label || '').toLowerCase().includes(low);

  // RUNNING SESSIONS FIRST. Parked ones accumulate for a fortnight and crowd every name — "golf"
  // matched a live session and a closed one from days ago, "status-hub" matched twelve — so a name
  // that picks out exactly one RUNNING session is not ambiguous in any sense Jared means it. Only
  // when nothing running matches does the whole list come into play, which is what "resume the X one"
  // needs.
  const live = rows.filter((r) => r.status === 'resident').filter(matches);
  const hits = live.length ? live : rows.filter(matches);
  if (hits.length === 1) return { ok: true, row: hits[0] };
  if (!hits.length) return { ok: false, error: `nothing matches '${want}'` };
  return { ok: false, error: `${hits.length} sessions match '${want}' — say the number: `
    + hits.map((h) => `${h.n} (${(h as any).label || h.repo})`).join(', ') };
}

/**
 * Hand a session to the other machine.
 *
 * The transfer is claimed by the machine GIVING IT UP, which closes the session, flushes the last of
 * the mirror and only then asks the destination to resume — one writer at a time, or the transcript
 * forks into two conversations with one id.
 *
 * When the source machine is not responding there is nothing to close and nothing left to flush, so
 * the destination is asked directly. That is the case this whole mechanism exists for: the laptop is
 * shut and the work should carry on somewhere else, using the mirror as of the last completed turn.
 */
export async function transferSession(ref: string, machine: Machine) {
  const found = await resolveSession(ref);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  const source: Machine = row.worker === 'desk' ? 'mac' : 'pi';
  const where = (m: Machine) => (m === 'mac' ? 'the Mac' : 'the Pi');
  if (source === machine) return { ok: false as const, error: `that session is already on ${where(machine)}` };
  if (!row.claude_session_id) {
    return { ok: false as const, error: 'that session has no transcript recorded, so there is nothing to move' };
  }
  if (!(await machineAwake(machine))) {
    const saved = await deadLetter('transfer_session', { session: row.id, target: source, to: machine },
                                   machine, `${where(machine)} is not responding`);
    return { ok: false as const, saved, error: `${where(machine)} is not responding, so nothing was moved. The request is saved.` };
  }

  if (await machineAwake(source)) {
    const id = uuid();
    const { error } = await getClient().from('desk_commands')
      .insert({ id, kind: 'transfer_session', payload: { session: row.id, target: source, to: machine } });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const, id, repo: row.repo, machine, live: true };
  }

  // Source unreachable: go straight to the destination with what was mirrored, and mark the old row
  // handed over so the source closes that session if it ever comes back with it still open.
  const id = uuid();
  const { error } = await getClient().from('desk_commands').insert({
    id, kind: 'resume_mirrored',
    payload: { target: machine, claude_session_id: row.claude_session_id, repo: row.repo,
               label: (row as any).label ?? null, origin: (row as any).origin ?? 'dispatched', from: source },
  });
  if (error) return { ok: false as const, error: error.message };
  await getClient().from('desk_sessions')
    .update({ status: 'transferred', ended: new Date().toISOString(), working: false }).eq('id', row.id);
  return { ok: true as const, id, repo: row.repo, machine, live: false };
}

export async function queued() {
  const { data } = await getClient().from('desk_queue').select('*').is('claimed', null).order('created');
  return data ?? [];
}

/**
 * Resume an evicted session with its full context, or end a running one.
 *
 * The target comes from the session's own row. Hardcoding 'pi' sent every Mac session's close and
 * resume to the Pi, which rejects the id outright — the Mac's are `mac-…`, and its consumer never
 * saw the command at all.
 */
export async function sessionCommand(kind: 'resume_session' | 'end_session', session: string, prompt?: string) {
  // Takes whatever Jared said — a number, a repo, an id — because these are spoken commands and the
  // id is the one form he will never use.
  const found = await resolveSession(session);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  session = row.id;
  const machine: Machine = row.worker === 'desk' ? 'mac' : 'pi';
  // Both machines park and resume now: a closed session with a recorded transcript comes back with
  // its whole conversation, in a new tab or a new tmux session. Only one without a transcript is
  // genuinely gone — that is what the `ended` status means, as against `evicted`.
  if (kind === 'resume_session' && (row as any).status === 'ended') {
    return { ok: false as const, error: 'that session has no transcript recorded, so there is nothing to resume' };
  }
  const payload = { session, target: machine, ...(prompt ? { prompt } : {}) };
  if (!(await machineAwake(machine))) {
    const saved = await deadLetter(kind, payload, machine, `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`);
    return { ok: false as const, saved,
             error: `The ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding, so that did not happen. It is saved and can be retried.` };
  }
  const id = uuid();
  const { error } = await getClient().from('desk_commands').insert({ id, kind, payload });
  if (error) return { ok: false as const, error: error.message };
  // Resuming makes that session the one you are talking to again, so follow-ups should go there.
  if (kind === 'resume_session') await setFocus(id, machine);
  return { ok: true as const, id };
}

/**
 * Name a session — and name the SESSION, not just our row.
 *
 * A live session is sent `/rename <name>`, which is the same command Jared types: Claude Code renames
 * itself, its terminal tab title changes, and it writes the `custom-title` record that the reconcile
 * tick reads back into `label` a moment later. The row is also set here so the pane changes at once
 * rather than a tick later.
 *
 * A parked session has no process to type into, so it gets the label alone; the name reaches the
 * session itself only if it is resumed.
 */
export async function renameSession(ref: string, name: string) {
  const clean = String(name || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60);
  if (!clean) return { ok: false as const, error: 'no name given' };
  const found = await resolveSession(ref);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  const machine: Machine = row.worker === 'desk' ? 'mac' : 'pi';

  await getClient().from('desk_sessions').update({ label: clean }).eq('id', row.id);
  if (row.status !== 'resident') {
    return { ok: true as const, name: clean, live: false, repo: row.repo };
  }
  if (!(await machineAwake(machine))) {
    // The label is already set, so nothing is lost — only the session's own name is out of step.
    return { ok: true as const, name: clean, live: false, repo: row.repo };
  }
  const id = uuid();
  const { error } = await getClient().from('desk_commands')
    .insert({ id, kind: 'rename_session', payload: { session: row.id, name: clean, target: machine } });
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, id, name: clean, live: true, repo: row.repo };
}

export function formatSessions(rows: DeskSession[], q: any[]): string {
  if (!rows.length && !q.length) return 'No sessions running or parked.';
  const lines: string[] = [];
  // Numbered, because the number is how Jared refers to one out loud, and it has to be the same
  // number the pane shows. The machine is named for the same reason: "move it to the Mac" needs him
  // to know where it is now.
  const numbered = numberSessions(rows);
  const line = (r: DeskSession & { n: number }) =>
    `- **${r.n}.** ${(r as any).label || r.repo} (${r.repo} on the ${r.worker === 'desk' ? 'Mac' : 'Pi'})`
    + ` — ${(r.last_reply || r.prompt || 'no output yet').replace(/\s+/g, ' ').slice(0, 100)}`;
  const res = numbered.filter((r) => r.status === 'resident');
  const ev = numbered.filter((r) => r.status === 'evicted');
  if (res.length) {
    lines.push(`**Running** (${res.length}):`);
    for (const r of res) lines.push(line(r));
  }
  if (ev.length) {
    lines.push(`**Parked** (${ev.length}, resumable with full context):`);
    for (const r of ev) lines.push(line(r));
  }
  if (q.length) {
    lines.push(`**Queued** (${q.length}, waiting for a slot):`);
    for (const r of q) lines.push(`- ${r.repo} — ${(r.prompt || '').slice(0, 80)}`);
  }
  return lines.join('\n');
}
