// The Watchset watch app's only way into Supabase. The app holds no Supabase key; anon has no grant on
// anything it touches (00160). Every request carries the device's own token in X-Device-Token,
// checked against the SHA-256 digests in this function's WORKSET_DEVICE_SHA256 secret (auth.mjs), and
// the work is done with the service role.
//
//   POST  /functions/v1/workset/report          {reps, occurred_at, session, algorithm}
//         -> 201 [row], the inserted report (what PostgREST's return=representation gives)
//   PATCH /functions/v1/workset/report?id=<id>  {corrected_reps} and/or {deleted}
//         -> 204, or 404 when no report with that id occurred in the last two hours
//   POST  /functions/v1/workset/watcher         -> 200 [{exercise, weight_lbs}], nulls when unarmed
//   POST  /functions/v1/workset/capture?session=<session>   body: text/csv
//         -> storage's status: 200 stored, 409 already stored
//
// A report becomes a logged set by the workset_report_to_set() trigger and an amendment edits that set
// by workset_report_amend() (00045/00046), so the function writes only the report columns. Only
// corrected_reps and deleted are amendable, and only on a report from the last two hours. set_id is
// never client-writable: workset_report_amend() acts on whatever set it names.
//
// No JWT check (config.toml): the watch holds no Supabase JWT.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { deviceAuthorised } from "./auth.mjs";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const AMEND_WINDOW_MS = 2 * 60 * 60 * 1000;
const BUCKET = "workset-captures";
const SESSION_RE = /^[A-Za-z0-9_-]{1,128}$/;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const isInt = (v: unknown) => Number.isInteger(v);
const optText = (v: unknown) => v === undefined || v === null || typeof v === "string";

async function fileReport(req: Request): Promise<Response> {
  const b = await req.json().catch(() => null);
  if (!b || !isInt(b.reps) || b.reps <= 0 || typeof b.occurred_at !== "string"
      || !Number.isFinite(Date.parse(b.occurred_at)) || !optText(b.session) || !optText(b.algorithm)) {
    return json({ error: "bad report" }, 400);
  }
  const { data, error } = await db.from("workset_reports")
    .insert({ reps: b.reps, occurred_at: b.occurred_at, session: b.session ?? null, algorithm: b.algorithm ?? null })
    .select();
  if (error) throw new Error(`insert: ${error.message}`);
  return json(data, 201);
}

async function amendReport(req: Request, q: URLSearchParams): Promise<Response> {
  const id = Number(q.get("id"));
  const b = await req.json().catch(() => null);
  if (!isInt(id) || id <= 0 || !b || typeof b !== "object") return json({ error: "bad amendment" }, 400);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(b)) {
    if (k === "corrected_reps" && isInt(b[k]) && b[k] > 0) patch[k] = b[k];
    else if (k === "deleted" && typeof b[k] === "boolean") patch[k] = b[k];
    else return json({ error: `cannot amend ${k}` }, 400);
  }
  if (!Object.keys(patch).length) return json({ error: "bad amendment" }, 400);
  const since = new Date(Date.now() - AMEND_WINDOW_MS).toISOString();
  const { data, error } = await db.from("workset_reports").update(patch)
    .eq("id", id).gt("occurred_at", since).select("id");
  if (error) throw new Error(`amend ${id}: ${error.message}`);
  return data && data.length ? new Response(null, { status: 204 }) : json({ error: "no recent report" }, 404);
}

async function watcher(): Promise<Response> {
  const { data, error } = await db.rpc("workset_watcher");
  if (error) throw new Error(`workset_watcher: ${error.message}`);
  return json(data);
}

async function capture(req: Request, q: URLSearchParams): Promise<Response> {
  const session = q.get("session") || "";
  if (!SESSION_RE.test(session)) return json({ error: "bad session" }, 400);
  const path = `workset/sensor_capture/${session}/motion.csv`;
  // Raw storage call rather than supabase-js so the bucket's own answer (size and type limits, an
  // existing object) reaches the watch unchanged. Never upsert: a recording is never overwritten.
  const r = await fetch(`${SB_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "text/csv", "x-upsert": "false" },
    body: req.body,
  });
  const text = await r.text();
  // Storage reports an existing object either as HTTP 409 or as a 400 whose body says 409.
  let status = r.status;
  try { if (JSON.parse(text).statusCode === "409") status = 409; } catch { /* not JSON */ }
  if (status >= 500) console.error(`[workset] capture ${session}: storage ${r.status} ${text.slice(0, 200)}`);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  try {
    if (!(await deviceAuthorised(req.headers.get("x-device-token") || "", Deno.env.get("WORKSET_DEVICE_SHA256") || ""))) {
      return json({ error: "unauthorized" }, 401);
    }
    const url = new URL(req.url);
    const route = url.pathname.split("/").filter(Boolean).pop();
    const q = url.searchParams;
    if (route === "report" && req.method === "POST") return await fileReport(req);
    if (route === "report" && req.method === "PATCH") return await amendReport(req, q);
    if (route === "watcher" && req.method === "POST") return await watcher();
    if (route === "capture" && req.method === "POST") return await capture(req, q);
    return json({ error: "not found" }, 404);
  } catch (e) {
    console.error(`[workset] failed: ${e instanceof Error ? e.message : e}`);
    return json({ error: "server error" }, 500);
  }
});
