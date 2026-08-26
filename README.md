# data-layer

Everything that reads or writes Jared's life data goes through here. Supabase is the store; this is
the only thing that talks to it directly, so behaviour lives in one place rather than in each caller.

Two entry points over the same modules:

| | what | who runs it |
|---|---|---|
| `dist/mcp.js` | 45 MCP tools | every Claude session, Mac and Pi, via `~/.claude.json` |
| `dist/http.js` | JSON API on `:27186` | `data-http.service` on the Pi; the Mac calls it |

**It runs from `dist/`, not `src/`.** A source change is invisible until `npm run build`. The
`pull-repos` timer on both machines rebuilds after it pulls, so a change made on one machine reaches
the other's sessions within about fifteen minutes.

## Modules

`mcp.ts` and `http.ts` are transports; neither holds logic. The domain modules underneath are what
both call, which is why the MCP and the API can never disagree about what a write means.

| module | owns |
|---|---|
| `lists.ts` | lists and their items, including dated ones — see below |
| `nutrition.ts` | food logging, targets, staged meals, leftovers |
| `workouts.ts` | sessions, sets, the exercise catalog, volume |
| `health.ts` | profile, height, weight |
| `recipes.ts` `notes.ts` `reviews.ts` | as named |
| `desk.ts` | dispatching Claude sessions to a machine, and the follow-up pointer |
| `reports.ts` | the HTML write-ups a dispatched session publishes |
| `helpers.ts` | ids, validation, and the clock — read it before using `now()` |
| `client.ts` | the Supabase client and where its key comes from |

## `now()` is not always the current time

`helpers.ts` is the one file to read before writing anything time-stamped. Under the voice worker,
`now()` returns **the moment Jared started speaking**, not the current instant: `voice-pipeline`'s
`worker.py` sets `DATA_TS_OVERRIDE` on this MCP subprocess from `voice_requests.capture_start`, and
`now()` honours it.

That is deliberate. A set logged by voice has to land at his rest-clock reference, not thirty seconds
later once transcription and routing have finished. Every caller inherits it — `today()` is the day he
spoke — so a module that keeps its own clock helper will silently disagree with every other table.
Use `helpers.now()`.

Without the override — typed commands, the HTTP API, direct callers — it is the machine's wall clock.

## There is no reminders table

A reminder is a list item with a `due` date. Any item on any list, dated, fires and badges
identically; nothing distinguishes a "reminder" from a dated grocery item, and there is no tool
named for one — `add_to_list` with a `due` is how you create one.

`repeat_every` on an item makes it recur: when it fires, `due` advances and `scheduled_at` keeps the
original anchor, which is what the overdue badge counts.

## Migrations

Numbered SQL in `supabase/migrations/`, applied with `./migrate.sh` from whichever machine wrote them
— both have the CLI authenticated and the project linked. Never edit an applied migration; add
another.

    ./migrate.sh            # push, then list what is applied

## The Supabase key

`client.ts` reads `SUPABASE_KEY` from the environment, falling back to a gitignored `.env` beside the
package so one-off `node -e` scripts work. Callers that set it themselves — the Fly app from secrets,
the voice worker from its own `.env`, the MCP from its launch config — are unaffected.

It is the **service_role** key: it bypasses RLS entirely, so anything holding it can read and write
every table.

## Two traps

**`resolution=merge-duplicates` upserts overwrite every column they send.** A column omitted from the
payload is set to null, not left alone. `pi-desk`'s reconcile tick learned this by blanking session
labels on the tick after they were written.

**A tool added here is invisible to voice until it is allow-listed.** The voice router runs on an
explicit `--allowedTools` list in `voice-pipeline/worker/worker.py`. A new tool omitted from it is
visible to the model but refused when called, which is what makes escalation to Opus work — see
`voice-pipeline/docs/ROUTING.md`.
