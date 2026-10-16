// The watch's way in when the hub (Fly `jared-status-hub`) cannot be reached.
//
// It runs on Supabase, not Fly, so a Fly outage does not take it down with the hub. It does the two
// things the hub's /api/voice-command does for a watch command — transcribe the clip, queue the
// command — and one thing the hub's /api/voice-reply does: hold a wait open until the command is done.
//
//   POST /functions/v1/voice-fallback?client_msg_id=…&client_now=…&dur=…&capture_start=…&capture_end=…&lat=…&lon=…&acc=…
//        body: the clip (audio/mp4)                      -> { transcript, id }
//   GET  /functions/v1/voice-fallback?id=<request id>    -> { status: pending|done|error, result, error }
//
// The row is queued with status `fallback`, which only the PI's worker claims (voice-pipeline
// worker.py `claim_fallback`): it runs the command on Opus with every tool, says it came the fallback
// way, and starts a session to find out why the hub did not answer. No other worker claims `fallback`,
// so a Fly worker that is up while the hub is down cannot take it.
//
// Auth is the hub's own device token (X-Hub-Token), checked against the sha256 the hub writes into
// `fallback_config` at boot. The Groq key is this function's own secret (`supabase secrets set
// GROQ_API_KEY=…`), the same key the hub holds on Fly. No JWT check (config.toml), since the watch holds
// no Supabase JWT.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const CLIP_BUCKET = "voice-clips";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_NOW_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const NOTHING_SAID = /^\W*thank\s+you\W*$/i;   // what Whisper writes for a clip with no speech in it
const WAIT_MS = 50_000;                          // under the watch's 60s request timeout; it asks again

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let config: Record<string, string> | null = null;
async function cfg(): Promise<Record<string, string>> {
  if (config) return config;
  const { data, error } = await db.from("fallback_config").select("key,value");
  if (error) throw new Error(`fallback_config: ${error.message}`);
  config = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return config;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function authed(req: Request): Promise<boolean> {
  const token = req.headers.get("x-hub-token") || "";
  if (!token) return false;
  const want = (await cfg()).hub_token_sha256;
  return !!want && (await sha256(token)) === want;
}

const isoAt = (v: string | null) => {
  const t = Date.parse(String(v || ""));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

function location(q: URLSearchParams) {
  const lat = parseFloat(q.get("lat") || ""), lon = parseFloat(q.get("lon") || "");
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const acc = parseFloat(q.get("acc") || "");
  return { lat: +lat.toFixed(5), lon: +lon.toFixed(5), ...(Number.isFinite(acc) ? { acc: Math.round(acc) } : {}) };
}

async function transcribe(clip: Uint8Array, type: string): Promise<string> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) throw new Error("GROQ_API_KEY is not set on the function");
  const form = new FormData();
  // Groq identifies the format by the file name's extension, not the part's content-type.
  form.append("file", new Blob([clip], { type }), "clip.m4a");
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "text");
  form.append("language", "en");
  const r = await fetch(GROQ_URL, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!r.ok) throw new Error(`groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.text()).replace(/\s+/g, " ").trim();
}

async function enqueue(req: Request, q: URLSearchParams): Promise<Response> {
  const msgId = q.get("client_msg_id") || "";
  // The watch's msgId IS the row id, so a resend finds the first send's row instead of running twice.
  const id = UUID_RE.test(msgId) ? msgId.toLowerCase() : crypto.randomUUID();
  const { data: prior } = await db.from("voice_requests").select("id,transcript").eq("id", id).maybeSingle();
  if (prior) return json({ transcript: prior.transcript, id: prior.id, duplicate: true });

  const clip = new Uint8Array(await req.arrayBuffer());
  if (!clip.length) return json({ error: "no audio" }, 400);
  const type = (req.headers.get("content-type") || "audio/mp4").split(";")[0].trim();
  const transcript = await transcribe(clip, type);
  if (!transcript || NOTHING_SAID.test(transcript)) return json({ transcript: "", id: null });

  const path = `${id}.m4a`;
  const dur = parseFloat(q.get("dur") || "");
  const up = await db.storage.from(CLIP_BUCKET).upload(path, clip, { contentType: type, upsert: true });
  const capture_start = isoAt(q.get("capture_start")), capture_end = isoAt(q.get("capture_end"));
  const client_now = CLIENT_NOW_RE.test(q.get("client_now") || "") ? q.get("client_now") : null;
  const loc = location(q);
  const { error } = await db.from("voice_requests").insert({
    id, transcript, source: "watch-fallback", focus: "hub", status: "fallback", always_on: false,
    ...(capture_start ? { capture_start } : {}), ...(capture_end ? { capture_end } : {}),
    ...(client_now ? { client_now } : {}), ...(loc ? { location: loc } : {}),
    ...(up.error ? {} : { audio: { path, bytes: clip.length, type, ...(dur > 0 ? { dur: +dur.toFixed(1) } : {}) } }),
  });
  if (error) {
    if (error.code === "23505") return json({ transcript, id, duplicate: true });   // a racing resend got there first
    throw new Error(`insert: ${error.message}`);
  }
  console.log(`[voice-fallback] queued ${id}: ${transcript.slice(0, 80)}`);
  return json({ transcript, id });
}

type Row = { status: string; result: string | null; error: string | null };
const outcomeOf = (r: Row) =>
  r.status === "done" ? { status: "done", result: r.result || "" }
  : r.status === "error" ? { status: "error", error: r.error || "" }
  : null;

// Held open on a realtime subscription to the one row, not a loop re-reading it. The row is read once
// more AFTER the subscription is up, so a finish that landed between the first read and the subscribe
// is not missed.
async function outcome(id: string): Promise<Response> {
  if (!UUID_RE.test(id)) return json({ error: "bad id" }, 400);
  const read = async () => {
    const { data } = await db.from("voice_requests").select("status,result,error").eq("id", id).maybeSingle();
    return data as Row | null;
  };
  const first = await read();
  if (!first) return json({ error: "no such request" }, 404);
  const now = outcomeOf(first);
  if (now) return json(now);

  let finish: (v: unknown) => void = () => {};
  const done = new Promise((res) => { finish = res; });
  const ch = db.channel(`fallback-${id}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "voice_requests", filter: `id=eq.${id}` },
      (p) => { const o = outcomeOf(p.new as Row); if (o) finish(o); })
    .subscribe(async (s) => {
      if (s !== "SUBSCRIBED") return;
      const again = await read();
      const o = again && outcomeOf(again);
      if (o) finish(o);
    });
  const timer = setTimeout(() => finish({ status: "pending" }), WAIT_MS);
  const o = await done;
  clearTimeout(timer);
  db.removeChannel(ch);
  return json(o);
}

Deno.serve(async (req) => {
  try {
    if (!(await authed(req))) return json({ error: "unauthorized" }, 401);
    const q = new URL(req.url).searchParams;
    if (req.method === "POST") return await enqueue(req, q);
    if (req.method === "GET") return await outcome(q.get("id") || "");
    return json({ error: "method" }, 405);
  } catch (e) {
    console.log(`[voice-fallback] failed: ${e instanceof Error ? e.message : e}`);
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});
