# Working in data-layer

Four things that will bite you, none of them visible from the code you are about to edit.

## It runs from `dist/`, not `src/`

Every consumer loads the build: sessions run `dist/mcp.js`, the Pi's `data-http.service` runs
`dist/http.js`. A source change does nothing until `npm run build`. If a change appears to have no
effect, check that first.

## `now()` is not the current time

Under the voice worker it returns **the moment Jared started speaking** — `voice-pipeline`'s
`worker.py` sets `DATA_TS_OVERRIDE` on this subprocess from `voice_requests.capture_start`, and
`helpers.now()` honours it. That is deliberate: a set logged by voice belongs at his rest-clock
reference, not thirty seconds later once transcription and routing have finished.

**Always use `helpers.now()` and `helpers.today()`.** A module with its own clock helper skips the
override and stamps voice-logged data late, which is exactly how nutrition disagreed with every other
table until it was fixed.

## Upserts null what they omit

`Prefer: resolution=merge-duplicates` overwrites every column in the payload — and a column left out
is set to null, not left alone. Send the columns you want preserved, even unchanged ones.

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
- Apply them with `./migrate.sh`, from whichever machine wrote them.
- Transport files (`mcp.ts`, `http.ts`) hold no logic — put it in the domain module so the MCP and the
  HTTP API cannot disagree about what a write means.
