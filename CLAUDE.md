# Working in data-layer

Seven things that will bite you, none of them visible from the code you are about to edit.

## It runs from `dist/`, not `src/`

Every consumer loads the build: sessions run `dist/mcp.js`, the Pi's `data-http.service` runs
`dist/http.js`. A source change does nothing until `npm run build`. If a change appears to have no
effect, check that first.

## `now()` is not the current time

Under the voice worker it returns **the moment Jared started speaking** — `voice-pipeline`'s
`worker.py` writes `voice_requests.capture_start` to the file named by `DATA_TS_FILE` at the start of
every command, and `helpers.now()` re-reads it per call. That is deliberate: a set logged by voice
belongs at his rest-clock reference, not thirty seconds later once transcription and routing have
finished.

It is a file rather than an env value because the worker's MCP session is warm (below). Passing the
timestamp in the environment froze it at the first command's value and stamped 29 hours of writes with
one moment before that was caught, on 2026-09-01.

**Always use `helpers.now()` and `helpers.today()`.** A module with its own clock helper skips the
override and stamps voice-logged data late, which is exactly how nutrition disagreed with every other
table until it was fixed.

## An exercise is named by its id, never by a string

`log_set`, `update_set` and `set_rep_watcher` take `exercise_id` from `get_workout_catalog`. There is
no name matching anywhere and none should be added: the name WAS the identity until 00075, so an
exact comparison decided whether an exercise existed and a plural read as an unknown movement. The
fix for that is not a looser comparison — anything willing to accept a near miss will eventually
write a set against the wrong exercise, and every volume figure derives from that association.

`upsert_catalog_exercise` is the one place a string names an exercise, because naming is what it is
for; it matches exactly, and returns the new id to log against.

`sets.exercise` still exists and still holds the name, but it is DERIVED — the `sets_resolve_exercise`
trigger fills it from `exercise_id` on every write, so it cannot disagree with the catalog. It is
still there because the hub reads it; it goes away when the hub reads the id instead. A writer that
passes only a name (the hub, 00046's watch-report trigger) still works and gets the right id, and an
unknown name raises rather than writing an orphan row.

## `ensureEastern()` will shift a time the user stated

Timestamp columns hold **naive local wall-clock** — `now()` writes `toEastern(new Date())`, with no
zone on it. `ensureEastern()` is the obvious-looking helper for a caller-supplied time and is the
wrong one: given a bare string it parses as **UTC** and converts, so a user's "1:51pm" is stored as
09:51 and the set lands in a different part of the day, or a different day.

It is named for what it does to a string that really is UTC (which is what Claude tends to emit for a
`date` argument), not for normalizing something a person said. When the value is a wall-clock reading
the user gave you, validate its shape and store it verbatim — `workouts.normalizeSetTime()` and
`lists.checkCompletedAt()` are the pattern: strict parse, round-trip through `Date` to reject
`2026-02-30` and `25:00`, no conversion.

Both exist because a time the user states is usually a time that has already PASSED — a set written
down afterwards, a task finished at 10:15 and mentioned at two. That is the whole reason those
overrides are there, so they are also where a shifted value does the most damage: the stated time is
being compared against something (a rest gap, a deadline), and an offset silently moves the answer
rather than breaking anything visibly.

## Upserts null what they omit

`Prefer: resolution=merge-duplicates` overwrites every column in the payload — and a column left out
is set to null, not left alone. Send the columns you want preserved, even unchanged ones.

## The voice worker holds this MCP warm — a rebuild alone does nothing

The worker's fast path (`SdkRunner`, primary since 2026-08-30) is one long-lived process holding the
data MCP as a **warm stdio session**, started once per worker lifetime. So `npm run build` gives voice
nothing: new tools stay invisible and changed schemas stay stale until the worker reconnects. Restart
it — `launchctl kickstart -k gui/$(id -u)/com.jaredgantt.voice-worker` on the Mac, `sudo systemctl
restart voice-worker` on the Pi. Both machines' `pull-repos` now do this on a data-layer change; a
build you run by hand still needs it.

The same process lifetime is why nothing per-command may live in that subprocess's **environment** —
it freezes there. See `helpers.now()`, which reads its timestamp from a file for exactly this reason.

## A new tool is invisible to voice until it is allow-listed

The voice router runs with an explicit `--allowedTools` list in `voice-pipeline/worker/worker.py`. A
tool missing from it stays visible in the schema and is refused when called, which is what makes
escalation to Opus work — so the omission looks like a model failure, not a config gap. Add the tool
there, or check the `validate_safe_tools()` line in the worker's startup log.

## A session is named by number, not by id

`resolveSession` takes what Jared actually says — "3", "status-hub", or a full id. The numbering rule
(`numberSessions`: active sessions by recency, **1 is the most recent**) is duplicated in the hub's
`/api/sessions` and the two must agree, or the pane and the voice tools disagree about which session
is which. The number is a position in the current list, never identity — closing one renumbers the
rest, which is what keeps the list 1..N over what is actually open. An
ambiguous name returns the choices rather than picking one: ending or moving the wrong session is not
recoverable.

## Conventions

- Migrations are numbered and append-only. Never edit one that has been applied; add another.
- **A migration that creates a table must also enable RLS on it.** Supabase defaults tables made
  this way to RLS *off*, and the anon key is public — it ships inside the Workset watch app — so a
  table without RLS is readable and writable by anyone holding it. `enable row level security` with
  no policy is the right default: service_role bypasses RLS, so nothing internal notices. Add
  policies only for a table a client genuinely reaches with the anon key, and grant only the verbs
  that client uses.
- Apply them with `./migrate.sh`, from whichever machine wrote them.
- Transport files (`mcp.ts`, `http.ts`) hold no logic — put it in the domain module so the MCP and the
  HTTP API cannot disagree about what a write means.
