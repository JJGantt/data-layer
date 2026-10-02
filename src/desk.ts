import { getClient } from './client.js';
import { uuid, whereJaredWas } from './helpers.js';

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
 * Write a command and wait for its machine to say what happened.
 *
 * An insert into the queue always succeeds, so answering at insert time reports "sent" for commands
 * the machine then refuses — the model repeats that to Jared and the words are lost from his view.
 * The channel is SUBSCRIBED BEFORE the insert, or a consumer that finishes in milliseconds is missed.
 * No verdict within CONFIRM_MS means it is still queued and may yet run: reported as unconfirmed,
 * never as delivered. A refused command is dead-lettered by the consumer that refused it.
 */
const CONFIRM_MS = 20_000;
export async function dispatchConfirmed(id: string, kind: string, payload: any):
  Promise<{ state: 'done' | 'error' | 'unconfirmed'; detail: string }> {
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
    const { error } = await client.from('desk_commands').insert({ id, kind, payload });
    if (error) return { state: 'error', detail: error.message };
    if (!subscribed) return { state: 'unconfirmed', detail: 'could not listen for the result' };
    const timer = new Promise<{ state: 'unconfirmed'; detail: string }>((r) =>
      setTimeout(() => r({ state: 'unconfirmed', detail: 'no answer from the machine yet' }), CONFIRM_MS));
    return await Promise.race([verdict, timer]);
  } finally {
    await client.removeChannel(channel);
  }
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
  command_id: string | null;
  // The last turn boundary — a prompt sent or a turn finished. Orders, numbers and focuses sessions.
  active_at: string | null;
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
export async function startSession(repo: string | undefined, prompt: string, machine: Machine = 'pi', report = false, label?: string, relay = false) {
  // No repo named, or one that matches nothing, lands in the home directory. A request the router
  // could not pin to a project still gets sent somewhere it can act — refusing it would be worse,
  // and the session can find its own way from there.
  const want = String(repo || '').trim();
  const hit = want && want.toLowerCase() !== 'root' ? await knownRepo(want) : null;
  const target = hit ?? { path: '~', name: 'root' };
  const id = uuid();
  // A hub dispatch carries where he was, so "get me a ride home" knows where the ride starts. His
  // words stay verbatim; the position is a separate bracketed line after them.
  const where = relay ? whereJaredWas() : '';
  if (where && prompt) prompt = `${prompt}\n\n[Where Jared was when he asked: ${where}]`;
  // `report` is opt-in and only ever set when Jared asked for a write-up. The launchers append
  // their report directive on this flag alone, so an ordinary dispatch stays a plain session.
  // `relay` asks the machine to post the session's first finished reply back into the hub thread
  // (voice-pipeline orchestrator/src/relay.js). Only a dispatch from the hub conversation sets it.
  const payload = { path: target.path, name: target.name, target: machine, ...(prompt ? { prompt } : {}), ...(report ? { report: true } : {}), ...(label ? { label: label.slice(0, 60) } : {}), ...(relay ? { relay: true } : {}) };
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
 * Whether `prompt` is the request the calling session was itself dispatched with. `session` is
 * HUB_SESSION_ID, which only the desk launchers set, so a session opened by hand is never caught.
 * Matched on the head of the new prompt inside the row's: start_session passes his words verbatim
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
 * Mark the dispatch just made, so a follow-up said before its session exists is held for it rather
 * than landing in whatever was active a moment earlier. It also releases a session Jared had focused by
 * name: starting new work is him turning to it.
 *
 * A command id, not a session id: at this moment the session does not exist yet. The machine creates
 * it a moment later, records command_id on the row and publishes it as the most recently active
 * session, which is what focus follows from then on (see focusedSession).
 */
/**
 * Point automatic focus at a dispatch — WITHOUT disturbing a pin.
 *
 * A pin is released by exactly three things: pinning another session, releasing it (unfocusSession),
 * or closing the pinned session by hand. Starting work is not one of them. Sessions are dispatched for
 * every small reason — a Walmart cart, a lookup — and a pin that any of those can silently take is not
 * a pin; the surfaces then disagree about which session is held, which is how this was noticed.
 *
 * The one exception is a pin pointing at a session that no longer exists at all. Nothing can release
 * that by hand, so it would block automatic focus for ever.
 */
export async function setFocus(commandId: string, machine: Machine) {
  const { data: f } = await getClient().from('desk_focus')
    .select('session_id').eq('id', 'current').maybeSingle();
  if (f?.session_id) {
    const { data: held } = await getClient().from('desk_sessions')
      .select('id').eq('id', f.session_id).maybeSingle();
    if (held) return;                       // his pin stands
  }
  await getClient().from('desk_focus')
    .upsert({ id: 'current', command_id: commandId, session_id: null, machine, updated: new Date().toISOString() },
            { onConflict: 'id' });
}

/** Release the pin if it is on this session — what closing one by hand means. */
export async function releaseFocusFor(sessionId: string) {
  const { data: f } = await getClient().from('desk_focus')
    .select('session_id').eq('id', 'current').maybeSingle();
  if (f?.session_id !== sessionId) return;
  await getClient().from('desk_focus').upsert(
    { id: 'current', session_id: null, command_id: null, machine: null, updated: new Date().toISOString() },
    { onConflict: 'id' });
}

/**
 * The session a spoken follow-up lands in, and the one every surface shows as focused. In order:
 *
 *   1. a session Jared FOCUSED BY NAME (`focus_session`), while it is still running. His explicit
 *      word outranks everything until he focuses another, releases it, or dispatches new work;
 *   2. a dispatch whose session has not opened yet (`pending`) — words said in that gap are meant for
 *      it, not for whatever was active a moment before;
 *   3. otherwise the MOST RECENTLY ACTIVE running session, on either machine.
 *
 * 3 includes the session he is typing in at his keyboard, which the pointer once excluded on purpose.
 * He chose this: the session he last used is the one he means. Ambient speech is guarded where it
 * always was — `follow_up` only runs when he hands words over ('tell it to…') — not by where the
 * pointer may go.
 *
 * The hub's `/api/sessions` implements the same rule (`pickFocus` in server.js). The two must agree,
 * or the wall shows one session as focused while a follow-up lands in another.
 */
export async function focusedSession(): Promise<{ session: DeskSession | null; pending: boolean }> {
  const [{ data: f }, rows] = await Promise.all([
    getClient().from('desk_focus').select('*').eq('id', 'current').maybeSingle(),
    listSessions(),
  ]);
  const running = rows.filter((r) => r.status === 'resident');
  if (f?.session_id) {
    // A pin holds the CONVERSATION, not the row. Eviction is not him closing a session, and a resume
    // makes a new row for the same transcript — so the pin re-attaches to whichever row is carrying it
    // now, and survives being parked in between.
    const pinnedRow = rows.find((r) => r.id === f.session_id);
    const conv = pinnedRow?.claude_session_id;
    const hit = running.find((r) => r.id === f.session_id)
      || (conv ? running.find((r) => r.claude_session_id === conv) : null);
    if (hit) return { session: hit, pending: false };
    if (pinnedRow) return { session: pinnedRow, pending: false };   // parked, and still his
  }
  if (f?.command_id && !rows.some((r) => r.command_id === f.command_id)) {
    // Only while it can still become a session: a command that failed or expired never will.
    const { data: c } = await getClient().from('desk_commands').select('status').eq('id', f.command_id).maybeSingle();
    if (c && (c.status === 'pending' || c.status === 'running')) return { session: null, pending: true };
  }
  return { session: numberSessions(running)[0] ?? null, pending: false };
}

/**
 * Pin a session, so what he says next goes there whatever else becomes active — until he pins another,
 * releases it (unfocusSession), or closes it by hand. Dispatching work does NOT release it, and neither
 * does eviction: a pin holds the conversation, and re-attaches to it when it is resumed. Unpinned,
 * focus follows activity.
 *
 * "Focus the latest session" is a pin like any other: of whichever session is newest NOW, which then
 * stays put while others become newer. Going back to automatic is a separate verb on purpose — when one
 * tool did both, "latest" could be read either way.
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
 * Release the pin: follow-ups go to whichever session is most recently active again. Returns that
 * session, so the answer can say where they go now.
 */
export async function unfocusSession() {
  await getClient().from('desk_focus').upsert(
    { id: 'current', session_id: null, command_id: null, machine: null, updated: new Date().toISOString() },
    { onConflict: 'id' });
  const { session: s } = await focusedSession();
  return { session: s?.id ?? null, repo: s?.repo ?? null, label: (s as any)?.label ?? null };
}

/**
 * Send a follow-up: to the session he NAMED, or with no name to the focused one (focusedSession).
 *
 * A named session gets the words whatever it is doing — running and mid-turn, they are typed in and
 * Claude Code queues them; parked, it is resumed with them. Naming a session routes this one message
 * and leaves the pin alone.
 *
 * With no name it can legitimately have nowhere to go, two ways that mean different things: a dispatch
 * has not opened its session yet (a launch takes a few seconds), or nothing is running at all. Saying
 * which saves Jared guessing whether it worked, and the words are kept either way.
 */
export async function followUp(prompt: string, ref?: string) {
  if (ref) {
    const found = await resolveSession(ref);
    if (!found.ok) return { ok: false as const, error: found.error };
    const row = found.row;
    if (row.status !== 'resident') {
      const r = await sessionCommand('resume_session', row.id, prompt);
      return r.ok ? { ...r, repo: row.repo, session: row.id } : r;
    }
    return deliverFollowUp(row, prompt);
  }
  const { session: s, pending } = await focusedSession();
  if (!s) {
    const reason = pending ? 'the last dispatch has not opened its session yet' : 'no session is running';
    let machine: Machine | null = null;
    if (pending) {
      const { data: f } = await getClient().from('desk_focus').select('machine').eq('id', 'current').maybeSingle();
      machine = f?.machine === 'mac' ? 'mac' : 'pi';
    }
    const saved = await deadLetter('follow_up', { session: null, prompt, ...(machine ? { target: machine } : {}) }, machine, reason);
    return { ok: false as const, saved, error: `${reason} — nothing was sent. The follow-up is saved and can be retried.` };
  }
  return deliverFollowUp(s, prompt);
}

async function deliverFollowUp(s: DeskSession, prompt: string) {
  const machine: Machine = s.worker === 'desk' ? 'mac' : 'pi';
  if (!(await machineAwake(machine))) {
    const saved = await deadLetter('follow_up', { session: s.id, prompt, target: machine }, machine,
                                   `the ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding`);
    return { ok: false as const, saved,
             error: `The ${machine === 'mac' ? 'Mac' : 'Pi'} is not responding, so the follow-up was not sent. It is saved and can be retried.` };
  }
  const id = uuid();
  const v = await dispatchConfirmed(id, 'follow_up', { session: s.id, prompt, target: machine });
  if (v.state === 'error') {
    return { ok: false as const, error: `The ${s.repo} session did not get it (${v.detail}). It is saved and can be retried.` };
  }
  return { ok: true as const, id, repo: s.repo, session: s.id, confirmed: v.state === 'done' };
}

/**
 * Sessions with a NUMBER, which is how they get talked about out loud.
 *
 * **1 is the most recently active.** Only ACTIVE sessions (resident or evicted) are numbered, so the
 * list is always 1..N over what is actually there.
 *
 * ORDERED BY `active_at`, the last TURN BOUNDARY — a prompt sent or a turn finished — because the
 * session he is using is the one he is talking about. Two other orders fail in opposite ways:
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
export function numberSessions(rows: DeskSession[]): (DeskSession & { n: number })[] {
  // RUNNING FIRST, then parked, most recent first within each. The number has to be the POSITION IN THE
  // LIST HE IS LOOKING AT — that is where "the second session" comes from — and every surface shows
  // running above parked. Numbering the two together by age alone put the running sessions at 12 and
  // 13 while parked ones held 1 through 11, so the badges read 12, 13, 1, 2, 3 down the screen and
  // the second row was not session two.
  //
  // It also keeps the low numbers on the sessions that can actually be spoken to: focus and follow-up
  // only reach a running one.
  const rank = (r: DeskSession) => (r.status === 'resident' ? 0 : 1);
  // Rows from before `active_at` existed fall back to their last reply, then to when they started.
  const activity = (r: DeskSession) => new Date(r.active_at || r.reply_at || r.started).getTime();
  return rows
    .filter((r) => r.status === 'resident' || r.status === 'evicted')
    .sort((a, b) => rank(a) - rank(b) || activity(b) - activity(a))
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
  const v = await dispatchConfirmed(id, kind, payload);
  if (v.state === 'error') return { ok: false as const, error: `${session}: ${v.detail}` };
  // Closing a session BY HAND is one of the three things that release a pin — the others being pinning
  // another and unfocusing. Anything automatic (eviction, a dispatch) leaves it alone.
  if (kind === 'end_session') await releaseFocusFor(session);
  // Resuming makes that session the one you are talking to again, so follow-ups should go there.
  if (kind === 'resume_session') await setFocus(id, machine);
  return { ok: true as const, id, confirmed: v.state === 'done' };
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

export function formatSessions(rows: DeskSession[], q: any[]): string {
  if (!rows.length && !q.length) return 'No sessions running or parked.';
  const lines: string[] = [];
  // Numbered, because the number is how Jared refers to one out loud, and it has to be the same
  // number the pane shows. The machine is named for the same reason: "move it to the Mac" needs him
  // to know where it is now.
  //
  // THE ID IS PRINTED BESIDE IT, because the number is a position in THIS listing and positions move.
  // Resuming or ending several sessions renumbers the list after each one — every resume promotes a
  // session from Parked to Running, which shifts everything below it — so a caller working from one
  // listing addresses a different session with each call. That happened: a batch of five resumes by
  // number reopened two copies of an unrelated session and missed three of the intended ones. An id
  // cannot go stale that way, and `resolveSession` has always accepted one; it simply was not shown
  // anywhere, so nothing could use it.
  const numbered = numberSessions(rows);
  // AN UNNAMED SESSION IS NOT CALLED "root". `label` is null until something names it — a session
  // Jared opened in a terminal himself is `adopted`, so no dispatch label was ever written, and
  // Claude Code's own generated title does not exist until the first exchange finishes. Falling back
  // to `repo` printed a dozen rows reading `root (root on the Mac)`, which looks like a name and is
  // the working directory. Nothing distinguished them from a session actually called that.
  const shown = (r: DeskSession) => (r as any).label || '(unnamed)';
  const line = (r: DeskSession & { n: number }) =>
    `- **${r.n}.** ${shown(r)} (${r.repo} on the ${r.worker === 'desk' ? 'Mac' : 'Pi'}) \`${r.id}\``
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
