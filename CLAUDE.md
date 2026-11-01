# Working in data-layer

Things that will bite you, none of them visible from the code you are about to edit.

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

## A list is named by its id, and `list_items.list_name` is derived

`lists.id` ('l_grocery') is the key; `list_items.list_id` is the reference; `lists.name` is a label
that can be edited without moving a row. Write `list_id` and nothing else — `list_name` is filled by
the `list_items_resolve_list` trigger, the same arrangement as `sets.exercise` and `exercise_id`, and
sending both is how the two get a chance to disagree.

`add_to_list` will NOT create a list, and that is the point rather than an omission. When the name was
the key, an unrecognised name was the only way to express "start a new list", so it had to be accepted
and a typo forked silently. Creation is `create_list` alone, which leaves `list_id` a closed set the
tool schema ships as an `enum`.

Do not add name matching to get around this. It is the `exercise_id` rule again, and for the same
reason: anything willing to accept a near miss eventually writes to the wrong list, and the write
looks entirely successful. The trigger raises on a name it cannot resolve, so PostgREST will not do it
either.

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

## Weekly volume is computed twice, and both copies must agree

`get_weekly_volume` here and `computeVolume` in status-hub's `server/lib/volume.js` answer the same
question for different surfaces — the spoken report and the muscle map. Three rules have to match, or
one calls a muscle short of a goal the other says it has met:

- **the window** — `days` DAY-BUCKETS on the 4am boundary, so `days = 7` opens at the start of the
  4am-day six days back. Subtracting `days * 86400000` from now opens a whole calendar day earlier,
  which is a day of sets the map does not count.
- **the per-bout clip** — a muscle earns at most 11 adjusted sets in one bout, where a bout is a run
  of sets with no gap over 3h. A second session hours later is a fresh bout with its own cap.
- **the targets** — `TARGET_DEFAULT` and the per-muscle overrides in `TARGETS`.

Duplicated rather than shared because the two repos ship separately. A change to any of the three
there has to be made here in the same breath.

## The voice worker holds this MCP warm — a rebuild alone does nothing

The worker's fast path (`SdkRunner`, primary since 2026-08-30) is one long-lived process holding the
data MCP as a **warm stdio session**, started once per worker lifetime. So `npm run build` gives voice
nothing: new tools stay invisible and changed schemas stay stale until the worker reconnects. Restart
it — `launchctl kickstart -k gui/$(id -u)/com.jaredgantt.voice-worker` on the Mac, `sudo systemctl
restart voice-worker` on the Pi. Both machines' `pull-repos` now do this on a data-layer change; a
build you run by hand still needs it.

The same process lifetime is why nothing per-command may live in that subprocess's **environment** —
it freezes there. See `helpers.now()`, which reads its timestamp from a file for exactly this reason.

It also pins DATA, not just code. `tools/list` builds the `list_id` **enum** from the lists that exist
at connect time (`listRoster` in `mcp.ts`), so a list made after the worker started is not a legal
value in the schema that worker is holding — voice cannot add to it until the session reconnects. The
server sends `notifications/tools/list_changed` on `create_list` and `delete_list`, but whether a
client re-fetches on it is the client's business, so treat a restart as the reliable path.

## A new tool is invisible to voice until it is allow-listed

The voice router runs with an explicit `--allowedTools` list in `voice-pipeline/worker/worker.py`. A
tool missing from it stays visible in the schema and is refused when called, which is what makes
escalation to Opus work — so the omission looks like a model failure, not a config gap. Add the tool
there, or check the `validate_safe_tools()` line in the worker's startup log.

## A session is named by number, not by id

`resolveSession` takes what Jared actually says — "3", "status-hub" — or an id. The id to SAVE is the
permanent handle `s-<first 8 of claude_session_id>` (`sessionHandle`), which `get_sessions` prints: a
row id names one stretch of a conversation and is replaced at the next resume. Any of them resolves to
the conversation's current row, so a stale row id still reaches the session instead of reopening an
old stretch of it beside the live one. The numbering rule (`numberSessions`: active sessions by last
turn boundary, `active_at`, **1 is the most recently active**, running and parked interleaved — parking is not activity — one row per conversation) is duplicated in the hub's `/api/sessions`, and so is the focus rule (`focusedSession` and the
hub's `pickFocus`). Each pair must agree, or the pane and the voice tools disagree about which session
is which, or the wall shows one session focused while a follow-up lands in another. The number is a position in the current list, never identity — closing one renumbers the
rest, which is what keeps the list 1..N over what is actually open. An
ambiguous name returns the choices rather than picking one: ending or moving the wrong session is not
recoverable.

## API keys: a secret key, sent as `apikey`

Every server-side consumer holds the `servers` secret key (`sb_secret_…`, role service_role) as its
`SUPABASE_KEY`; apps hold a publishable key (`sb_publishable_…`): `default` in Workset, `apps` for
the restaurant menu app. A secret key is not a JWT, and the gateway accepts it only in the **`apikey`
header** — `Authorization: Bearer` alone is a 401. Sending both (what supabase-js and every raw
fetch here do) works, and supabase-js 2.106+ and realtime-py 2.31 subscribe with it.

The `default` secret key is what Supabase injects into edge functions as `SUPABASE_SERVICE_ROLE_KEY`
(voice-fallback runs on it), so deleting it breaks the function; the `default` publishable is injected
as `SUPABASE_ANON_KEY` and is Workset's. The legacy JWT `anon` / `service_role` keys are still
enabled only for the restaurant menu app's build on testers' phones; nothing else may go back to them.

## Conventions

- Migrations are numbered and append-only. Never edit one that has been applied; add another.
- **A migration that creates a table must also enable RLS on it.** Supabase defaults tables made
  this way to RLS *off*, and the client keys are public — the publishable keys ship inside the Workset
  and restaurant menu apps and act as `anon` — so a table without RLS is readable and writable by anyone
  holding one. `enable row level security` with no policy is the right default: service_role bypasses
  RLS, so nothing internal notices. Add policies only for a table a client genuinely reaches with a
  publishable key, and grant only the verbs that client uses.
- Apply them with `./migrate.sh`, from whichever machine wrote them.
- Transport files (`mcp.ts`, `http.ts`) hold no logic — put it in the domain module so the MCP and the
  HTTP API cannot disagree about what a write means.
