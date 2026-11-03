import { getClient } from './client.js';
import { uuid } from './helpers.js';

// Dispatching work to a machine, and seeing what is already running there.
//
// The queue this writes into is drained by a consumer on the target machine (pi-desk on the Pi, the
// orchestrator on the Mac). Nothing here touches either machine directly — the hub runs on Fly and
// this MCP runs wherever it runs, so Supabase carries both directions.

// 'fly' is never chosen by a caller: it is where startSession sends work when neither the Pi nor the Mac
// can take it (voice-pipeline fly-desk/). Its sessions are addressed like any other once they exist.
export type Machine = 'pi' | 'mac' | 'fly';

/** The worker each machine's desk consumer heartbeats as. */
const DESK_WORKER: Record<Machine, string> = { pi: 'pi-desk', mac: 'desk', fly: 'fly-desk' };
/** Which machine a session row belongs to, from the worker that publishes it. */
export const machineOf = (worker: string | null | undefined): Machine =>
  worker === 'desk' ? 'mac' : worker === 'fly-desk' ? 'fly' : 'pi';
const asMachine = (m: unknown): Machine => (m === 'mac' || m === 'fly' ? m : 'pi');

/**
 * Start the Fly session machine and report whether it answered.
 *
 * It is stopped almost always, so it has no fresh heartbeat to read. Fly's proxy starts a stopped machine
 * for any request to it and holds the request until the host is listening, so a 200 here means the host
 * is up and will drain a command written next. A cold start is seconds; the timeout is for a Fly outage.
 */
const FLY_DESK_URL = process.env.FLY_DESK_URL || 'https://jared-desk-fly.fly.dev';
async function wakeFly(): Promise<boolean> {
  try {
    const r = await fetch(`${FLY_DESK_URL}/wake`, { signal: AbortSignal.timeout(45_000) });
    return r.ok;
  } catch (e: any) {
    console.error('[desk] waking the Fly machine:', e?.message || e);
    return false;
  }
}
// Same 90s the hub and pi-desk use: three missed 30s beats.
const DESK_STALE_S = 90;

/**
 * Is the machine that would run this actually there?
 *
 * Checked BEFORE a command is written, because the queue has no way to fail: a command for a machine
 * that is asleep is claimed by nobody, expires unread, and the caller was already told it started.
 */
export async function machineAwake(machine: Machine): Promise<boolean> {
  if (machine === 'fly') return wakeFly();
  const { data } = await getClient().from('worker_presence')
    .select('last_seen').eq('worker', DESK_WORKER[machine]).maybeSingle();
  const t = data?.last_seen;
  return !!t && (Date.now() - new Date(t).getTime()) / 1000 <= DESK_STALE_S;
}

const NAME: Record<Machine, string> = { pi: 'Pi', mac: 'Mac', fly: 'Fly machine' };
export const machineName = (m: Machine) => NAME[m];

/**
 * Which agent a session runs: Claude Code, or OpenAI's Codex CLI (voice-pipeline orchestrator/src/codex.js)
 * for when Claude cannot take the work. The hub draws a Codex session blue.
 */
export type Agent = 'claude' | 'codex';
/**
 * The agent a dispatch defaults to. DATA_AGENT=codex is set on this MCP by whatever is itself running
 * because Claude could not: the voice worker's Codex fallback and its API-credits runner (a Claude session
 * would be refused at the usage limit), and every Codex session (pi-desk/launch-codex.sh). Work it hands
 * on lands on Codex unless the caller names an agent.
 */
export const defaultAgent = (): Agent => (process.env.DATA_AGENT === 'codex' ? 'codex' : 'claude');
type Readiness = { ok: true } | { ok: false; why: string; login: string | null };

/**
 * Can each machine start a session right now — beating AND signed in?
 *
 * A session runs on the machine's interactive `/login`, which dies on a fixed date about four weeks after
 * sign-in; one started after that answers "Login expired" and does nothing. Each desk heartbeat carries
 * the date (`info.login_expires_at`, voice-pipeline orchestrator/src/login.js), so this is one read of
 * two rows, with nothing asked of either machine. `login` is the expired date, set only when the login
 * is the reason. A beat without the field (a consumer not yet updated) counts as signed in.
 */
export async function machinesReady(agent: Agent = 'claude'): Promise<Record<'pi' | 'mac', Readiness>> {
  const { data } = await getClient().from('worker_presence')
    .select('worker, last_seen, info').in('worker', [DESK_WORKER.pi, DESK_WORKER.mac]);
  const out = {} as Record<'pi' | 'mac', Readiness>;
  for (const m of ['pi', 'mac'] as const) {
    const row = data?.find((r: any) => r.worker === DESK_WORKER[m]);
    const t = row?.last_seen;
    const exp = row?.info?.login_expires_at;
    if (!t || (Date.now() - new Date(t).getTime()) / 1000 > DESK_STALE_S) {
      out[m] = { ok: false, why: `the ${NAME[m]} is not responding`, login: null };
    } else if (agent === 'codex') {
      // A Codex session needs Codex signed in there (`info.codex`), and nothing of the Claude login.
      out[m] = row?.info?.codex === true ? { ok: true }
        : { ok: false, why: `Codex is not signed in on the ${NAME[m]}`, login: null };
    } else if (exp !== undefined && !(exp && Date.parse(exp) > Date.now())) {
      out[m] = { ok: false, why: `the ${NAME[m]}'s Claude login has expired`, login: exp || 'none' };
    } else {
      out[m] = { ok: true };
    }
  }
  return out;
}

/**
 * Write a command and wait for its machine to say what happened.
 *
 * An insert into the queue always succeeds, so answering at insert time reports "sent" for commands
 * the machine then refuses — the model repeats that to the user and the words are lost from view.
 * The channel is SUBSCRIBED BEFORE the insert, or a consumer that finishes in milliseconds is missed.
 * No verdict within CONFIRM_MS means it is still queued and may yet run: reported as unconfirmed,
 * never as delivered. A refused command is dead-lettered by the consumer that refused it.
 */
const CONFIRM_MS = 20_000;
type Verdict = { state: 'done' | 'error' | 'unconfirmed'; detail: string };

/**
 * Wait for command `id` to reach a verdict. `write` runs once the listener is live — the insert, for a
 * new command — so a consumer that answers in milliseconds cannot be missed; with no write, the row is
 * read once after subscribing instead, for a command that may already have finished.
 */
async function awaitVerdict(id: string, write?: () => Promise<string | null>): Promise<Verdict> {
  const client = getClient();
  let settle!: (v: { state: 'done' | 'error'; detail: string }) => void;
  const verdict = new Promise<{ state: 'done' | 'error'; detail: string }>((r) => { settle = r; });
  const channel = client.channel(`desk-cmd-${id}`)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'desk_commands', filter: `id=eq.${id}` },
      (m: any) => {
        const st = m.new?.status;
        if (st === 'done' || st === 'error') settle({ state: st, detail: String(m.new?.detail || '') });
      });
  const subscribed = await new Promise<boolean>((r) => {
    const t = setTimeout(() => r(false), 5_000);
    channel.subscribe((st) => {
      if (st === 'SUBSCRIBED') { clearTimeout(t); r(true); }
      else if (st === 'CHANNEL_ERROR' || st === 'TIMED_OUT' || st === 'CLOSED') { clearTimeout(t); r(false); }
    });
  });
  try {
    if (write) {
      const err = await write();
      if (err) return { state: 'error', detail: err };
    } else {
      const { data } = await client.from('desk_commands').select('status,detail').eq('id', id).maybeSingle();
      if (data?.status === 'done' || data?.status === 'error') return { state: data.status, detail: String(data.detail || '') };
    }
    if (!subscribed) return { state: 'unconfirmed', detail: 'could not listen for the result' };
    const timer = new Promise<{ state: 'unconfirmed'; detail: string }>((r) =>
      setTimeout(() => r({ state: 'unconfirmed', detail: 'no answer from the machine yet' }), CONFIRM_MS));
    return await Promise.race([verdict, timer]);
  } finally {
    await client.removeChannel(channel);
  }
}

export async function dispatchConfirmed(id: string, kind: string, payload: any): Promise<Verdict> {
  return awaitVerdict(id, async () => {
    const { error } = await getClient().from('desk_commands').insert({ id, kind, payload });
    return error ? error.message : null;
  });
}

/**
 * Follow a Pi command that handed its work to the Mac. A Pi with no memory to spare sends a new
 * session or a resume on to the Mac as a fresh command and answers `handed to the Mac as <id> — why`;
 * that is not a launch, so the Mac's own verdict is what gets reported. Anything else passes through.
 */
async function followHandoff(id: string, v: Verdict, machine: Machine):
  Promise<{ id: string; v: Verdict; machine: Machine; handedOff: string | null }> {
  const m = v.state === 'done' ? /^handed to the Mac as (\S+)(?: — (.*))?/.exec(v.detail) : null;
  if (!m) return { id, v, machine, handedOff: null };
  return { id: m[1], v: await awaitVerdict(m[1]), machine: 'mac', handedOff: m[2] || 'no room on the Pi' };
}

/**
 * Keep a command that could not run.
 *
 * A dispatched prompt is usually minutes of dictated speech that cannot be said again the same way,
 * so nothing is ever dropped — it is parked here with the reason, and retried later only if the user
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
  const machine = asMachine(row.machine);
  if (!(await machineAwake(machine))) {
    return { ok: false as const, error: `the ${NAME[machine]} is still not responding — leaving it saved` };
  }
  const cmdId = uuid();
  const { error } = await getClient().from('desk_commands')
    .insert({ id: cmdId, kind: row.kind, payload: { ...row.payload, target: machine } });
  if (error) return { ok: false as const, error: error.message };
  await getClient().from('desk_dead_letters')
    .update({ retried: new Date().toISOString(), retry_command_id: cmdId }).eq('id', id);
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
  command_id: string | null;
  // The last turn boundary — a prompt sent or a turn finished. Orders, numbers and focuses sessions.
  active_at: string | null;
  // The agent process running it, on the row's own machine.
  pid: number | null;
  // Claude Code or Codex (`Agent`); for Codex, claude_session_id is the Codex thread id.
  agent?: Agent;
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
export async function startSession(repo: string | undefined, prompt: string, machine: Machine = 'pi', report = false, label?: string, relay = false, repair = false, agent: Agent = 'claude') {
  // No repo named, or one that matches nothing, lands in the home directory. A request the router
  // could not pin to a project still gets sent somewhere it can act — refusing it would be worse,
  // and the session can find its own way from there.
  const want = String(repo || '').trim();
  const hit = want && want.toLowerCase() !== 'root' ? await knownRepo(want) : null;
  const target = hit ?? { path: '~', name: 'root' };
  const id = uuid();
  // `report` is opt-in and only ever set when Jared asked for a write-up. The launchers append
  // their report directive on this flag alone, so an ordinary dispatch stays a plain session.
  // `relay` asks the machine to post the session's first finished reply back into the hub thread
  // (voice-pipeline orchestrator/src/relay.js). Only a dispatch from the hub conversation sets it.
  const payload = { path: target.path, name: target.name, target: machine, ...(prompt ? { prompt } : {}), ...(report ? { report: true } : {}), ...(label ? { label: label.slice(0, 60) } : {}), ...(relay ? { relay: true } : {}), ...(agent === 'codex' ? { agent } : {}) };
  // The machine has to be able to run it NOW: beating, and signed in. Writing the command anyway is the
  // silent failure this guards — nobody claims it, or it launches a session that cannot authenticate,
  // and the reply already said a session had started. The one asked for first, then the other.
  //
  // With neither, the Fly machine takes it: it runs on the year-long token, so no login date applies, but
  // it has no browser and no Remote Control, which is why it is last rather than an equal.
  const ready = await machinesReady(agent);
  const asked = machine === 'mac' ? 'mac' : 'pi';
  const other = asked === 'pi' ? 'mac' : 'pi';
  const fail = ready[asked];
  let rerouted: string | null = null;
  if (!fail.ok) {
    if (ready[other].ok) {
      machine = other;
      rerouted = fail.why;
    } else {
      const why = `${fail.why}, and ${(ready[other] as { why: string }).why}`;
      if (!(await wakeFly())) {
        const saved = await deadLetter('open_session', payload, asked, `${why}, and the Fly machine did not start`);
        return { ok: false as const, machine: asked, saved,
                 error: `Nothing was started: ${why}, and the Fly machine did not start. The prompt is saved and can be retried.` };
      }
      machine = 'fly';
      rerouted = why;
    }
    payload.target = machine;
  }
  // A dead login is a problem with a known fix, so it gets a session of its own that fixes it, run on
  // the machine that still works. Once per expired login, however many dispatches route around it.
  // The repair session needs a shell on the other machine (the runbook drives the Pi's login from the
  // Mac), so it is started only where one of the two still works, never on Fly.
  if (!fail.ok && fail.login && !repair && machine !== 'fly' && agent === 'claude') await startLoginRepair(asked, fail.login, machine, relay);
  // Confirmed, not inserted: a machine short of room QUEUES the session instead of launching it
  // (pi-desk runQueue), and reporting "started" for a session that is waiting would be wrong for as long as
  // it sits in the queue, which can be days.
  const f = await followHandoff(id, await dispatchConfirmed(id, 'open_session', payload), machine);
  const v = f.v;
  if (v.state === 'error') return { ok: false as const, error: v.detail };
  const state = v.state === 'unconfirmed' ? 'unconfirmed' as const
    : /^queued\b/.test(v.detail) ? 'queued' as const : 'launched' as const;
  return { ok: true as const, id: f.id, repo: target.name, machine: f.machine, matched: !!hit || !want, state,
           detail: v.detail, handedOff: f.handedOff, rerouted, agent };
}

/**
 * Start a session, in the health repo, whose job is to renew `dead`'s login — on `on`, the machine
 * that can still run one. `expired` is the date the dead login carried; the marker in app_settings
 * holds it, so a second dispatch around the same dead login does not start a second repair, while the
 * next time it expires (a new date) does. The procedure lives in health/runbooks/claude-login.md.
 */
async function startLoginRepair(dead: Machine, expired: string, on: Machine, relay: boolean) {
  const key = `login_repair_${dead}`;
  const client = getClient();
  const { data } = await client.from('app_settings').select('value').eq('key', key).maybeSingle();
  if (data?.value === expired) return;
  await client.from('app_settings').upsert({ key, value: expired, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  const prompt = `The ${NAME[dead]}'s interactive Claude login has expired (its refresh token's expiry was ${expired}), `
    + `so sessions are being started on the ${NAME[on]} instead. Renew the ${NAME[dead]}'s login by following `
    + `runbooks/claude-login.md in this repo, verify it with the probe there, and tell Jared what you did.`;
  const r = await startSession('health', prompt, on, false, `Renew ${NAME[dead]} Claude login`, relay, true);
  if (!r.ok) console.error(`[desk] login repair for ${dead}: ${r.error}`);
}

/**
 * Whether `prompt` is the request the calling session was itself dispatched with. `session` is
 * HUB_SESSION_ID, which only the desk launchers set, so a session opened by hand is never caught.
 * Matched on the head of the new prompt inside the row's: start_session passes the user's words verbatim
 * minus the addressing, so a re-dispatch is the same text with "start a session in X" taken off the
 * front. The row keeps only 500 characters of the prompt, which is why only the head is compared.
 */
export async function redispatch(session: string | undefined, prompt: string) {
  if (!session) return false;
  const flat = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const head = flat(prompt).slice(0, 120);
  if (head.length < 20) return false;
  const { data } = await getClient().from('desk_sessions').select('prompt').eq('id', session).maybeSingle();
  return !!data?.prompt && flat(data.prompt).includes(head);
}

/**
 * PINS. Any number of conversations can be pinned; a pin holds a session at the top of every list (the
 * numbering in `desk_sessions_state()`, migration 00164), most recently pinned first. The SHOWN session —
 * the wall's reply column and footer, the watch's default — is the most recently pinned one, else the most
 * recently active running session. A pin is on the CONVERSATION, so it survives every resume and every
 * move between machines. Only an explicit unpin or closing the session by hand releases it; dispatching
 * other work never does.
 */
export async function pinSession(ref: string) {
  const found = await resolveSession(ref);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  const { error } = await getClient().from('desk_pins')
    .upsert({ conv: conversationOf(row), pinned_at: new Date().toISOString() }, { onConflict: 'conv' });
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, session: sessionHandle(row), repo: row.repo, label: (row as any).label ?? null };
}

export async function unpinSession(ref: string) {
  const found = await resolveSession(ref);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  const { data, error } = await getClient().from('desk_pins').delete().eq('conv', conversationOf(row)).select('conv');
  if (error) return { ok: false as const, error: error.message };
  return { ok: true as const, session: sessionHandle(row), repo: row.repo, label: (row as any).label ?? null,
           was: !!data?.length };
}

/** Closing a session by hand releases its pin. */
async function unpinRow(sessionId: string) {
  const { data: row } = await getClient().from('desk_sessions')
    .select('id, claude_session_id').eq('id', sessionId).maybeSingle();
  if (!row) return;
  const { error } = await getClient().from('desk_pins').delete().eq('conv', row.claude_session_id || row.id);
  if (error) console.error(`[desk] unpin ${sessionId}: ${error.message}`);
}

/**
 * Send a follow-up to the session the caller NAMED. There is no default: the caller (the orchestrator)
 * has the conversation and knows which session the words are for, and a guess at "the focused one" is
 * how words land in the wrong session.
 *
 * A named session gets the words whatever it is doing — running and mid-turn, they are typed in and
 * Claude Code queues them; parked, it is resumed with them; on a machine that is asleep, it moves.
 */
export async function followUp(prompt: string, ref: string) {
  const found = await resolveSession(ref);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  if (row.status !== 'resident') {
    // Parked on a machine that is asleep: resume it somewhere awake rather than wait for the lid.
    if (!(await machineAwake(machineOf(row.worker)))) {
      const moved = await followUpElsewhere(row, prompt);
      if (moved) return moved;
    }
    const r = await sessionCommand('resume_session', row.id, prompt);
    return r.ok ? { ...r, repo: row.repo, session: row.id } : r;
  }
  return deliverFollowUp(row, prompt);
}

async function deliverFollowUp(s: DeskSession, prompt: string) {
  const machine = machineOf(s.worker);
  if (!(await machineAwake(machine))) {
    const moved = await followUpElsewhere(s, prompt);
    if (moved) return moved;
    const saved = await deadLetter('follow_up', { session: s.id, prompt, target: machine }, machine,
                                   `the ${NAME[machine]} is not responding`);
    return { ok: false as const, saved,
             error: `The ${NAME[machine]} is not responding, so the follow-up was not sent. It is saved and can be retried.` };
  }
  const id = uuid();
  const v = await dispatchConfirmed(id, 'follow_up', { session: s.id, prompt, target: machine });
  if (v.state === 'error') {
    return { ok: false as const, error: `The ${s.repo} session did not get it (${v.detail}). It is saved and can be retried.` };
  }
  return { ok: true as const, id, repo: s.repo, session: s.id, confirmed: v.state === 'done' };
}

/**
 * A follow-up for a session whose machine is ASLEEP goes to the session, not to the machine: the
 * conversation is moved to a machine that is awake (as transferSession does with the source down,
 * from what was mirrored as of the last completed turn) and resumed there with the words as its next
 * prompt. A closed laptop is the ordinary case, and the user should not have to know which machine a
 * session was living on to talk to it.
 *
 * Null when it cannot move — a Codex session (not mirrored), one with no transcript, or no machine
 * that will take it, Fly included — and the caller falls back to saving the words.
 */
async function followUpElsewhere(row: DeskSession, prompt: string) {
  const source = machineOf(row.worker);
  if (!row.claude_session_id || row.agent === 'codex') return null;
  // The other home machine first, then Fly, the last resort as for new work (startSession): waking it
  // is the slow check, so it is asked only when both home machines are out.
  const order: Machine[] = (source === 'mac' ? ['pi'] : source === 'pi' ? ['mac'] : ['pi', 'mac']);
  if (source !== 'fly') order.push('fly');
  let dest: Machine | null = null;
  for (const m of order) if (await machineAwake(m)) { dest = m; break; }
  if (!dest) return null;
  const r = await resumeMirrored(row, source, dest, { prompt });
  if (!r.ok) return { ok: false as const, error: r.error };
  return { ok: true as const, id: r.id, repo: row.repo, session: sessionHandle(row), moved: dest,
           note: `the ${NAME[source]} is not responding, so the session was moved to the ${NAME[dest]} with its whole conversation and the follow-up sent there` };
}

/**
 * Resume a session's mirrored conversation on `dest` and mark the old row handed over, so `source`
 * closes that session if it ever comes back with it still open. Only for a source that is NOT
 * responding: an awake source must close and flush first (transferSession's live path).
 */
async function resumeMirrored(row: DeskSession, source: Machine, dest: Machine, extra: { prompt?: string } = {}) {
  const id = uuid();
  const { error } = await getClient().from('desk_commands').insert({
    id, kind: 'resume_mirrored',
    payload: { target: dest, claude_session_id: row.claude_session_id, repo: row.repo,
               label: (row as any).label ?? null, origin: (row as any).origin ?? 'dispatched', from: source,
               ...(extra.prompt ? { prompt: extra.prompt } : {}) },
  });
  if (error) return { ok: false as const, error: error.message };
  await getClient().from('desk_sessions')
    .update({ status: 'transferred', ended: new Date().toISOString(), working: false }).eq('id', row.id);
  return { ok: true as const, id };
}

/**
 * Sessions with a NUMBER, which is how they get talked about out loud.
 *
 * **1 is the PINNED session, else the most recently active** (migration 00163), so a pin puts it at the
 * top of every surface's list. Only ACTIVE sessions (resident or evicted) are numbered, so the
 * list is always 1..N over what is actually there.
 *
 * ORDERED BY `active_at`, the last TURN BOUNDARY — a prompt sent or a turn finished — because the
 * session in use is the one being talked about. Two other orders fail in opposite ways:
 * `last_seen` is touched by every reconcile tick, so the list reshuffled every 30s between two reads
 * seconds apart (measured), and `started` never moves, which kept a session in active use below newer
 * idle ones. `active_at` moves only when a session does something, so a number said out loud can still
 * change before it is resolved — but only if a session starts or finishes a turn in those seconds.
 *
 * The number is a POSITION, not identity: it belongs to the list, not to the session, and closing one
 * renumbers the rest. Numbers that stick to a session drift upward for ever and you end up saying
 * "session eleven" to name one of four things on screen.
 *
 * The hub's `/api/sessions` implements the identical rule; the two have to agree or the pane and the
 * voice tools disagree about which session is which.
 */
/**
 * The conversation a row carries. A SESSION IS ITS CONVERSATION, not a row: every resume makes a new
 * row (a new tab on the Mac, a new tmux session on the Pi) for the same Claude Code transcript, and
 * `claude --resume` keeps the transcript's id, so `claude_session_id` is the one thing that stays put.
 */
export function conversationOf(r: DeskSession): string {
  return r.claude_session_id || r.id;
}

/**
 * The PERMANENT handle every tool shows and takes: `s-` and the conversation's first eight characters.
 * A row id names one stretch of the conversation and is replaced on the next resume, so a row id saved
 * in a note goes stale — and resuming the stale one opened a second copy of a conversation already
 * running. Row ids still resolve (`resolveSession`), through their conversation.
 */
export function sessionHandle(r: DeskSession): string {
  return r.claude_session_id ? `s-${r.claude_session_id.slice(0, 8)}` : r.id;
}

/** `desk_sessions_state()` (migration 00164): the numbering, the pins and the shown session, the ONE definition,
 *  which the hub's /api/sessions reads too. */
async function sessionsState(): Promise<{
  numbers: Record<string, number>; pins: string[]; focus: { session_id: string | null; pinned: boolean; pending: boolean } }> {
  const { data, error } = await getClient().rpc('desk_sessions_state');
  if (error) throw new Error(`desk_sessions_state: ${error.message}`);
  return data;
}

/**
 * The listed sessions, numbered as every surface numbers them: one row per conversation, most recently
 * active first, running and parked together (the rule and why are in migration 00157). The number is
 * the position in the list the user is looking at, which is where "the second session" comes from.
 */
export async function numberSessions(rows: DeskSession[]): Promise<(DeskSession & { n: number; pinned: boolean })[]> {
  const { numbers, pins } = await sessionsState();
  const pinned = new Set(pins || []);
  return rows.filter((r) => numbers[r.id] != null).map((r) => ({ ...r, n: numbers[r.id], pinned: pinned.has(r.id) }))
    .sort((a, b) => a.n - b.n);
}

export async function listSessions(): Promise<DeskSession[]> {
  const { data } = await getClient().from('desk_sessions').select('*').order('last_seen', { ascending: false });
  return (data ?? []) as DeskSession[];
}

/**
 * Find the session someone named — by number ("session three"), by repo or label, by its permanent
 * handle (`s-…`, `sessionHandle`) or by a row id. A handle or row id lands on the CURRENT row of that
 * conversation, so an old row id saved somewhere still reaches the session rather than reopening a
 * stretch of it.
 *
 * An ambiguous name is answered with the choices rather than a guess: picking one of three status-hub
 * sessions at random and then ending or moving it is not a recoverable mistake.
 */
export async function resolveSession(ref: string): Promise<
  { ok: true; row: DeskSession & { n: number } } | { ok: false; error: string }> {
  const want = String(ref || '').trim();
  if (!want) return { ok: false, error: 'which session?' };
  const all = await listSessions();
  const rows = await numberSessions(all);
  if (!rows.length) return { ok: false, error: 'no sessions are running or parked' };

  const low = want.toLowerCase();
  if (/^\d+$/.test(want)) {
    const hit = rows.find((r) => r.n === Number(want));
    return hit ? { ok: true, row: hit }
               : { ok: false, error: `there is no session ${want} — there are ${rows.length}` };
  }
  // A row id, or the conversation's id or its prefix (the handle is `s-` and eight of it).
  const hex = low.replace(/^s-/, '');
  const named = all.find((r) => r.id === want)
    || (/^[0-9a-f-]{8,}$/.test(hex) ? all.find((r) => (r.claude_session_id || '').startsWith(hex)) : undefined);
  if (named) {
    const conv = conversationOf(named);
    if (/^[0-9a-f-]{8,}$/.test(hex) && named.id !== want
        && new Set(all.filter((r) => (r.claude_session_id || '').startsWith(hex)).map(conversationOf)).size > 1) {
      return { ok: false, error: `more than one session starts with ${want} — use more of its id` };
    }
    const hit = rows.find((r) => conversationOf(r) === conv);
    return hit ? { ok: true, row: hit }
               : { ok: false, error: `${want} is ${named.status}, so it cannot be reached or resumed` };
  }

  const matches = (r: DeskSession & { n: number }) =>
    String(r.repo || '').toLowerCase().startsWith(low)
    || String((r as any).label || '').toLowerCase().includes(low);

  // RUNNING SESSIONS FIRST. Parked ones accumulate for a fortnight and crowd every name — "golf"
  // matched a live session and a closed one from days ago, "status-hub" matched twelve — so a name
  // that picks out exactly one RUNNING session is not ambiguous in any sense the user means it. Only
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
  const source = machineOf(row.worker);
  const where = (m: Machine) => `the ${NAME[m]}`;
  if (source === machine) return { ok: false as const, error: `that session is already on ${where(machine)}` };
  if (!row.claude_session_id) {
    return { ok: false as const, error: 'that session has no transcript recorded, so there is nothing to move' };
  }
  // A Codex rollout is not mirrored, and the receiving machine would resume it as a Claude conversation.
  if (row.agent === 'codex') {
    return { ok: false as const, error: 'that is a Codex session, and Codex sessions stay on the machine that started them' };
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

  // Source unreachable: go straight to the destination with what was mirrored.
  const r = await resumeMirrored(row, source, machine);
  if (!r.ok) return { ok: false as const, error: r.error };
  return { ok: true as const, id: r.id, repo: row.repo, machine, live: false };
}

export async function queued() {
  const { data } = await getClient().from('desk_queue').select('*').is('claimed', null).order('created');
  return data ?? [];
}

/**
 * Whether `row` is the session this MCP server belongs to. The desk launchers export the row id as
 * HUB_SESSION_ID on every machine. A session opened by hand at the Mac has no such variable, so
 * there the parent pid decides: this server is a stdio child of the claude process, whose pid is on
 * the row. Only on the Mac, the one darwin machine: on Linux a pid match could be a different box.
 */
function isSelf(row: DeskSession): boolean {
  if (process.env.HUB_SESSION_ID && process.env.HUB_SESSION_ID === row.id) return true;
  return process.platform === 'darwin' && machineOf(row.worker) === 'mac'
    && row.pid != null && Number(row.pid) === process.ppid;
}

/**
 * Resume an evicted session with its full context, or end a running one.
 *
 * The target comes from the session's own row. Hardcoding 'pi' sent every Mac session's close and
 * resume to the Pi, which rejects the id outright — the Mac's are `mac-…`, and its consumer never
 * saw the command at all.
 */
export async function sessionCommand(kind: 'resume_session' | 'end_session', session: string, prompt?: string) {
  // Takes whatever the user said — a number, a repo, an id — because these are spoken commands and the
  // id is the one form nobody says aloud.
  const found = await resolveSession(session);
  if (!found.ok) return { ok: false as const, error: found.error };
  const row = found.row;
  session = row.id;
  const machine = machineOf(row.worker);
  // Both machines park and resume now: a closed session with a recorded transcript comes back with
  // its whole conversation, in a new tab or a new tmux session. Only one without a transcript is
  // genuinely gone — that is what the `ended` status means, as against `evicted`.
  if (kind === 'resume_session' && (row as any).status === 'ended') {
    return { ok: false as const, error: 'that session has no transcript recorded, so there is nothing to resume' };
  }
  // A session closing ITSELF is mid-turn by definition: it is running the tool call that asked. Closed
  // now, the process dies before it writes the reply, and the watch and phone get no answer at all. So
  // its host is told to close it after this turn instead (close_after_turn, migration 00143), once the
  // reply has been published.
  if (kind === 'end_session' && isSelf(row)) {
    const { error } = await getClient().from('desk_sessions')
      .update({ close_after_turn: new Date().toISOString() }).eq('id', row.id);
    if (error) return { ok: false as const, error: `could not mark ${session} to close: ${error.message}` };
    await unpinRow(session);
    return { ok: true as const, self: true as const, id: row.id, machine };
  }
  const payload = { session, target: machine, ...(prompt ? { prompt } : {}) };
  if (!(await machineAwake(machine))) {
    const saved = await deadLetter(kind, payload, machine, `the ${NAME[machine]} is not responding`);
    return { ok: false as const, saved,
             error: `The ${NAME[machine]} is not responding, so that did not happen. It is saved and can be retried.` };
  }
  const sent = uuid();
  const f = await followHandoff(sent, await dispatchConfirmed(sent, kind, payload), machine);
  const v = f.v;
  if (v.state === 'error') return { ok: false as const, error: `${session}: ${v.detail}` };
  // Closing a session BY HAND releases its pin, as unpinning does. Eviction and dispatches leave pins alone.
  if (kind === 'end_session') await unpinRow(session);
  return { ok: true as const, id: f.id, machine: f.machine, confirmed: v.state === 'done', detail: v.detail,
           queued: v.state === 'done' && /^queued\b/.test(v.detail), handedOff: f.handedOff };
}

/**
 * Name a session — and name the SESSION, not just our row.
 *
 * A live session is sent `/rename <name>`, which is the same command typed by hand: Claude Code renames
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
  const machine = machineOf(row.worker);

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

/**
 * Which wall the TV shows.
 *
 * The kiosk cannot be navigated from outside — it is a browser on a machine nothing here can reach —
 * so the setting is written and the page follows it. It applies only to the TV; the phone app serves
 * the same markup and must not be dragged along.
 */
/**
 * Which walls exist. 'home' is NOT one of them: it is a second word for 'standard', normalised at the
 * MCP so one value is stored and nothing downstream has to decide which of two names is current.
 */
export type WallMode = 'standard' | 'health' | 'sessions' | 'calendar';

export async function setWall(mode: WallMode, months?: number) {
  // `calendar_months` rides along because voice sizes the calendar wall in the same utterance that
  // picks it ("show the full year") — the hub's /api/calendar reads it back as the month count.
  const rows: { key: string; value: string }[] = [{ key: 'wall_mode', value: mode }];
  if (months) rows.push({ key: 'calendar_months', value: String(months) });
  const { error } = await getClient().from('app_settings').upsert(rows, { onConflict: 'key' });
  return error ? { ok: false as const, error: error.message } : { ok: true as const, mode };
}

/**
 * Each session's last answer as one sentence, keyed by conversation: the summary the host wrote for
 * the push notification (data-layer 00133), taken only when it belongs to the turn the row shows.
 * A summary of an older turn says nothing about the current one, so the turn is matched on reply_at.
 */
export async function turnSummaries(rows: DeskSession[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const withReply = rows.filter((r) => r.reply_at);
  if (!withReply.length) return out;
  const { data } = await getClient().from('desk_turns').select('conversation,at,summary')
    .in('conversation', [...new Set(withReply.map(conversationOf))]).not('summary', 'is', null);
  const byTurn = new Map((data ?? []).map((t: any) => [`${t.conversation}@${new Date(t.at).getTime()}`, t.summary as string]));
  for (const r of withReply) {
    const summary = byTurn.get(`${conversationOf(r)}@${new Date(r.reply_at!).getTime()}`);
    if (summary) out.set(conversationOf(r), summary);
  }
  return out;
}

export function formatSessions(numbered: (DeskSession & { n: number; pinned?: boolean })[], q: any[], summaries: Map<string, string> = new Map()): string {
  if (!numbered.length && !q.length) return 'No sessions running or parked.';
  const lines: string[] = [];
  // Numbered, because the number is how the user refers to one out loud, and it has to be the same
  // number the pane shows. The machine is named for the same reason: "move it to the Mac" needs the
  // user to know where it is now.
  //
  // THE ID IS PRINTED BESIDE IT, because the number is a position in THIS listing and positions move.
  // Resuming or ending several sessions renumbers the list after each one — every resume makes that
  // session the most recently active, which shifts everything above where it was — so a caller working from one
  // listing addresses a different session with each call. An id cannot go stale that way, and
  // `resolveSession` accepts one.
  // AN UNNAMED SESSION IS NOT CALLED "root". `label` is null until something names it — a session
  // opened in a terminal by hand is `adopted`, so no dispatch label was ever written, and
  // Claude Code's own generated title does not exist until the first exchange finishes. Falling back
  // to `repo` prints rows reading `root (root on the Mac)`, which looks like a name and is the working
  // directory, indistinguishable from a session actually called that.
  const shown = (r: DeskSession) => (r as any).label || '(unnamed)';
  const line = (r: DeskSession & { n: number; pinned?: boolean }) =>
    `- **${r.n}.** ${shown(r)} (${r.repo} on the ${NAME[machineOf(r.worker)]}${r.agent === 'codex' ? ', on Codex' : ''}) \`${sessionHandle(r)}\``
    + ` — ${lastSaid(r)}`;
  // WHAT IT LAST SAID is the turn's one-sentence summary — what it did, or the question it ends on —
  // because a reply cut at a fixed length loses its end, which is where a question for the user sits. No
  // summary means the reply is under 200 characters (short enough to show whole) or the summariser
  // failed or has not finished, so the reply itself is shown, still bounded: a dozen long reports
  // would bury the list.
  const lastSaid = (r: DeskSession) => summaries.get(conversationOf(r))
    || (r.last_reply || r.prompt || 'no output yet').replace(/\s+/g, ' ').slice(0, 200);
  // ONE LIST IN NUMBER ORDER, each row saying whether it runs: the number is the position by activity
  // alone, so splitting Running from Parked would print the numbers out of order.
  if (numbered.length) {
    const nRes = numbered.filter((r) => r.status === 'resident').length;
    lines.push(`**Sessions** (${nRes} running, ${numbered.length - nRes} parked — a parked one resumes with full context):`);
    for (const r of numbered) lines.push(line(r) + (r.status === 'resident' ? '' : ' _(parked)_') + (r.pinned ? ' _(pinned)_' : ''));
  }
  if (q.length) {
    lines.push(`**Queued** (${q.length}, waiting for a slot):`);
    for (const r of q) lines.push(`- ${r.repo} — ${(r.prompt || '').slice(0, 80)}`);
  }
  return lines.join('\n');
}

// ── Subscription usage gate for new sessions ────────────────────────────────────────────────────────
// Sessions are what spend the Claude 5-hour and weekly windows; voice turns barely move them, and when a
// window is exhausted they fall back to API credits anyway (voice-pipeline worker, SDK_CREDITS). So a
// dispatch is held back at a high reading, leaving the window for voice, unless the user says to start it
// anyway. Thresholds: from 75% the session starts and the user is told the reading; from 90% it does
// not start until the user confirms. The reading is the newest `claude_usage` row (00144),
// written after every turn by the voice worker and by each machine's Stop hook.
export const USAGE_NOTE_PCT = 75;
export const USAGE_HOLD_PCT = 90;

export interface UsageReading { five: number; fiveResets: string | null; week: number; weekResets: string | null; at: string }

export async function usageNow(): Promise<UsageReading | null> {
  const { data, error } = await getClient().from('claude_usage')
    .select('five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, observed_at')
    .order('observed_at', { ascending: false }).limit(1);
  if (error) { console.error(`claude_usage read failed: ${error.message}`); return null; }
  const r = data?.[0];
  if (!r) return null;
  return { five: Number(r.five_hour_pct), fiveResets: r.five_hour_resets_at, week: Number(r.seven_day_pct),
           weekResets: r.seven_day_resets_at, at: r.observed_at };
}

// "5-hour 92% (resets in 1h 20m), weekly 61% (resets in 3d 4h)", for the model to relay.
export function describeUsage(u: UsageReading): string {
  const left = (iso: string | null) => {
    if (!iso) return 'reset time unknown';
    const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000));
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return 'resets in ' + (d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`);
  };
  return `5-hour ${Math.round(u.five)}% (${left(u.fiveResets)}), weekly ${Math.round(u.week)}% (${left(u.weekResets)})`;
}

// A window whose reset has already passed reads 0 until the next turn reports it, so a stale high
// reading never holds a session back after the window turned over.
export function effectivePct(u: UsageReading): number {
  const live = (pct: number, resets: string | null) => (resets && Date.parse(resets) <= Date.now() ? 0 : pct);
  return Math.max(live(u.five, u.fiveResets), live(u.week, u.weekResets));
}
