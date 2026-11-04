# data-layer

Everything that reads or writes the personal life data (workouts, nutrition, lists, health) goes through here. Supabase is the store; this is
the only thing that talks to it directly, so behaviour lives in one place rather than in each caller.

Two entry points over the same modules:

| | what | who runs it |
|---|---|---|
| `dist/mcp.js` | the MCP tools | every Claude session, Mac and Pi, via `~/.claude.json` |
| `dist/http.js` | JSON API on `127.0.0.1:27186` (`DATA_HTTP_HOST` to widen; bearer `DATA_HTTP_TOKEN` on every request, JSON bodies only), and with `HOME_AGENT=1` the Pi's home-network jobs (below) | `data-http.service` on the Pi; its one caller is gmail-watcher's Walmart handler |

Both run from `dist/`; `pull-repos` rebuilds after pulling, so a change made on one machine reaches
the other's sessions within about fifteen minutes. `CLAUDE.md` covers what to know before editing.

`dist/http.js` reports its errors and beats to the ops responder (health/responder) through
`ops_report.cjs`, a copy of that repo's reporter (edit it there). A request it rejects as invalid (400)
is answered, not reported; any other failure is `console.error`, which is what reports it.

## Modules

`mcp.ts` and `http.ts` are transports; neither holds logic. The domain modules underneath are what
both call, which is why the MCP and the API can never disagree about what a write means.

| module | owns |
|---|---|
| `lists.ts` | lists and their items, including dated ones — see below |
| `nutrition.ts` | food logging, targets, staged meals, leftovers |
| `workouts.ts` | sessions, sets, the exercise catalog, volume |
| `health.ts` | profile, height, weight |
| `recipes.ts` | saved recipes — see below |
| `ingredients.ts` | the ingredient itself: validation, produce rules, rollup, scaling |
| `reviews.ts` | as named |
| `surf.ts` | the forecast read (`get_surf`) and a surf alarm's conditions (`set_surf_alarm`, table `surf_alarms`). It only stores them: the hub decides and owns the alarm — status-hub `docs/ALARMS.md` |
| `location.ts` | the user's last known location (`get_location`, table `locations`), one row per device, kept by a trigger from the fix a command carries |
| `desk.ts` | dispatching Claude sessions to a machine, and the follow-up pointer |
| `reports.ts` | the HTML write-ups a dispatched session publishes |
| `bedroomTv.ts` | the bedroom TV (`bedroom_tv`, table `tv_commands`): inserts a command and awaits the TV's answer. The hub relays it to the TV's app; google-tv `docs/VOICE.md` |
| `youtube.ts` | public YouTube (`youtube` search / video / related / channel), parsed from the JSON YouTube embeds in its pages |
| `youtubeAccount.ts` | the owner's YouTube account (`youtube` history / home / subscriptions / …), signed in with the Pi browser's cookies. Runs only on the Pi |
| `ytParse.ts` | YouTube's renderer JSON, old and new shapes, flattened to rows; shared by the two above |
| `catalog.ts` | what is streaming where (`catalog`), from JustWatch, with Android TV deep links |
| `homeRequests.ts` | reads only the Pi can answer (table `home_requests`): any machine asks, data-http on the Pi answers |
| `tvHome.ts` | the bedroom TV's home-network end on the Pi: power over Wake-on-LAN and adb, remote keys over adb, and a wake before `open` / `launch` / `input` |
| `realtime.ts` | `onInserts`, the reconnecting INSERT subscription both Pi jobs run on |
| `helpers.ts` | ids, validation, and the clock — read it before using `now()` |
| `client.ts` | the Supabase client and where its key comes from |

`shopping_items` is the saved retailer catalogue: `retailer, item_id, name, default_qty,
last_verified`. Three MCP tools cover it — `get_shopping_items` (read it whole; it is small and has
no search), `build_walmart_cart_url` (ids + quantities -> one URL that fills the cart in a single
navigation), and `save_shopping_item`. Quantities ADD to the cart, so pass deltas. The catalogue
holds only items that have actually been bought: an item found by search and put in a cart is not
saved, so `build_walmart_cart_url` refuses it and the affiliate URL is built by hand.

Amazon has no cart URL — its documented `/gp/aws/cart/add.html` adds nothing — so an Amazon row saves
the search, not the session.

The cart URL takes ids, not names, because reading the list and choosing one is the step that picks
the right product; a name matcher has to reject "milk" as ambiguous against a milkshake cereal.

## The Pi's home-network jobs

Some things only a machine on the home network can do: wake the bedroom TV (Wake-on-LAN, adb), or read
the owner's YouTube account through the Pi's signed-in automation browser. The voice worker usually runs on
Fly, which can do neither. So the caller writes a row (`tv_commands`, `home_requests`) and data-http
on the Pi, subscribed to inserts, does the work and fills in the answer. Realtime both ways; nothing
polls.

It runs inside data-http rather than as its own service, so it costs one realtime socket and no
extra process; data-http measures about 75MB resident with it on. It is switched on by
`HOME_AGENT=1` in `/etc/systemd/system/data-http.service.d/home-agent.conf` on the Pi. Every row is
claimed before it is acted on (`claimed_by`, set by `onInserts` in `realtime.ts`), so a second machine
with it set would find each row taken rather than act on it twice; it is still meant for the Pi alone,
which is the machine on the home network.

## There is no reminders table, and no notes table

A reminder is a list item with a `due` date. Any item on any list, dated, fires and badges
identically; nothing distinguishes a "reminder" from a dated grocery item, and there is no tool
named for one — `add_to_list` with a `due` is how you create one.

**`list_items.alarm` is the one exception to "dated items are all alike."** A dated item notifies; a
dated item with `alarm` RINGS — on the TV and on any open hub page, on a loop from its moment until
someone stops it (status-hub's `docs/ALARMS.md` has the mechanism). It is false by default and nothing
infers it — not priority, not wording — because a soup timer should wake the room and an errand at 2am
should not.

`add_to_list` takes `alarm`, `set_alarm` turns it on or off afterwards, and every list line prints
`[alarm]` so a reader can tell which dated items will ring. Both tool descriptions refuse to infer
it, the same way `priority` does and for a sharper reason: a wrong guess here wakes a room, and
nothing on any surface says a guess was made. The hub's `POST /api/todos/alarm` is the same switch
from the other side.

## Pins are a set, released only by hand

`desk_pins` holds one row per pinned CONVERSATION (`claude_session_id`, else the row id) with when it
was pinned, so a pin survives eviction, resume and a move between machines. Any number can be pinned
(`pin_session`). `desk_sessions_state()` numbers pinned sessions first, most recently pinned on top,
which is the order every surface lists them in, and the most recently pinned one is the SHOWN session
(`focus`: the wall's reply column and footer); with nothing pinned it is the most recently active running
session. Only `unpin_session` or closing the session by hand (`end_session`) removes a pin — dispatching
work never does, since sessions are started for every small reason.

`follow_up` has no default target: it always names its session, because the orchestrator holds the
conversation and a guess at "the focused one" puts words in the wrong session.

## A list is addressed by its ID

`lists.id` is the key ('l_grocery'), and `list_items.list_id` is the reference. The name is a label:
editable, and not what anything points at. Renaming a list moves no rows.

That exists to make a wrong list REJECTABLE. If a name were the key, "a name not in the table" would
be the only way to say "start a new list", so a typo (`groceries` against `grocery`) would silently
fork a list. Two verbs keep the two requests apart:

| | |
|---|---|
| `add_to_list` | takes a `list_id` that must ALREADY exist. `requireList` throws otherwise, naming every valid id. |
| `create_list` | the only thing that mints a list, and the only place a name is chosen. |

With creation out of the way, `list_id` has a closed set, so `tools/list` ships it as an **`enum`**
(`listRoster` / `listIdProp` in `mcp.ts`). A validating client rejects a bad value before the call is
sent; `requireList` rejects it again server-side, because not every client validates.

The ids are readable on purpose. They go in an enum a model picks from, and an opaque key would make
that choice unverifiable — it could not tell which id was the grocery list without another call. They
are still ids: minted once from the name, never recomputed.

Two consequences worth knowing:

- **The schema is built once per session**, so creating or deleting a list makes it stale. Both send
  `notifications/tools/list_changed`, and the server advertises `tools.listChanged`.
- **`list_items.list_name` is DERIVED**, filled by the `list_items_resolve_list` trigger from
  `list_id` — the same arrangement as `sets.exercise` and `exercise_id`. Read it, never write it. It
  is still there because the hub draws it on every list surface.

The database enforces this independently of any caller: that trigger resolves a name-only write to an
id and RAISES when it cannot, so a fork is not reachable even by writing to PostgREST directly.

A note is a list item with a BODY: an undated row on the `notes` list, its short name in `title` and
its full text in `text` (migration 00092). It has no tools of its own either. `get_lists` prints an
item's `text` indented under the label whenever the two differ, so reading a note back is just
reading the list — and any other item carrying a body, like an Amazon row with a part number, shows it
the same way.

Recurrence is materialised rather than stored (migration 00085). `repeat_every` on `add_to_list` is
an instruction executed once: it writes one dated row per occurrence out to `repeat_until`, all
sharing a `series_id`. There is no repeating item — checking one off leaves the rest alone, and a
skipped week is seven separate misses. `remove_from_list` with `series` clears what is left of one.

COMPLETING a dated item is the scoring event, and deleting one is not. `complete_item` stamps
`completed_at` and the row stays as a record of something that happened; `remove_from_list` takes it
away and is worth nothing in either direction. The hub reads `completed_at` off the row to draw the
gold band on its health bar: on time earns, late earns less and eventually costs, and anything left
sitting overdue drains for as long as it sits. Nothing mediates that: the completed row is its own
record.

Because the completion TIME is the whole input to it, `complete_item` takes `at` for one being
reported after the fact — "I finished that at 10:15", or a 10am thing finished a quarter of an hour
in. Leaving it out stamps `now()`, which is what nearly every completion is. It takes a bare local
wall-clock reading, refuses one carrying a zone, and refuses one in the future, which the band's
replay would skip and so silently score at nothing. `lists.checkCompletedAt` decides that.

## A recipe ingredient is a nutrition ingredient

The same record, validated by the same code in `ingredients.ts`: `food`/`amount`/`unit`, its own
macros, its own produce classification. That is not tidiness — logging a recipe EXPANDS into those
rows scaled by servings, so anything a recipe ingredient cannot carry is something a meal loses the
moment it is eaten from a recipe rather than typed out.

So the totals on `recipes` (and on `nutrition_entries`) are a **cached rollup, never an input**. A
save re-derives them from the ingredients; nothing else may set them. A caller that sends recipe-level
macros is describing a recipe that cannot be logged correctly.

`log_recipe` is the only tool that logs one, and it takes just a name and a serving count. It is
separate from `log_nutrition` so that the voice router can allow it on the fast path — see
`voice-pipeline/docs/ROUTING.md`. `save_recipe` also accepts `from_entry`, which builds the recipe
from a meal already in the log.

A recipe is used only when the user explicitly calls it one ("my oatmeal recipe"). A meal described
by a past log ("same as yesterday") is copied from that entry, never from a recipe that shares its name:
the recipe can differ from what was actually eaten, and each "same as yesterday" then copies the error forward.

## Migrations

Numbered SQL in `supabase/migrations/`, applied with `./migrate.sh` from whichever machine wrote them
— both have the CLI authenticated and the project linked. Never edit an applied migration; add
another.

    ./migrate.sh            # push, then list what is applied

`00009_dashboard_tables.sql` is numbered below migrations already applied, so the CLI refuses a plain
push until it is recorded on the project: `echo y | supabase db push --include-all` applies it (a no-op
there, every table already exists) and lets `./migrate.sh` work again.

## Tests

    npm test          # build, then the unit tests (no network, no secrets)
    npm run test:db   # the SQL tests, against a throwaway Postgres in Docker

Run both before pushing; CI (`.github/workflows/test.yml`) runs both again on every push to main.

They cover only what is easy to break and costly when it is: the ingredient rollup and produce
totals, recipe and leftover scaling, the 4am eating day, repeat expansion and lateness on dated
items, which completion times are honoured, the `now()` clock, the HTTP API's token gate, and the two
SQL functions that hold shared rules, `muscle_volume()` and `desk_sessions_state()`. Transports and
the Supabase calls themselves are not tested.

The unit tests import `dist/`, the code that actually runs, so `npm test` builds first. They run under
`TZ=America/New_York`, because the clock and the DST cases are only meaningful in a zone with DST.
`test/http-auth.test.mjs` starts the real `dist/http.js` with Supabase and the ops responder pointed at
a closed local port, so nothing it does reaches either.

`bin/test-db` starts Supabase's own Postgres image (`public.ecr.aws/supabase/postgres`, the version
the project runs, about 1.7GB once pulled), applies every migration in order, runs `test/db/`, and
removes the container. Each test runs inside a transaction that is rolled back. `TEST_DATABASE_URL`
points it at an existing fresh database instead (CI's service container); `test/db/db.mjs` refuses
anything that is not local, because the tests empty whole tables inside their transactions.

Every migration must apply on a fresh database, or the run fails. The only thing provided first is a
stub of the `storage` schema (Supabase's storage service owns it, and the bare image does not run
that service). A table made in the dashboard rather than in a migration breaks this, and also breaks
rebuilding the schema from migrations; write it down as a migration instead (00009 and 00158 are the
ones that were).

## Backups

Supabase is the only copy of every life table, so `./backup.sh` writes a second one to the Mac:

    ./backup.sh                 # -> ~/supabase-backups/supabase-YYYY-MM-DD.tar.gz  (~2.6MB)

One `.jsonl` per table plus a `_manifest.txt` row count, driven off the PostgREST OpenAPI root so a
new table is picked up without touching this script. A daily launchd agent
(`com.jaredgantt.supabase-backup`, 04:15) runs it on the Mac, which then rsyncs the whole directory
to `pi:~/supabase-backups`. Three copies: Supabase, Mac, Pi.

It usually runs in a dark wake while the network is still coming up, so every fetch retries a dropped
connection or a 5xx with backoff (2s, 5s, 15s, 30s) before the run fails.

The mirror is best-effort and says so in the log — the Mac cannot always reach the Pi, and a backup
that succeeded locally must not report failure because the mirror did not run. Mirroring the
directory rather than the day's file means the Pi inherits the same retention automatically.

**Data only — no schema.** That is not an omission: the schema is `supabase/migrations/`, which is
in git and better protected than a tarball. A restore is `./migrate.sh` to rebuild the schema, then
load the rows. The gap to know about is anything created in the Supabase dashboard and never written
as a migration — that exists in no backup at all, which is why `bin/test-db` fails on a migration
that depends on one.

Retention keeps every 1st-of-month dump forever plus the last 14 of anything else, so the archive
grows about 50MB a year rather than 1GB. The tarball is listed with `tar tzf` before it replaces
anything, because a truncated backup nobody opens until they need it is worse than none.

`pg_dump` is not on either machine and `supabase db dump` hangs against the pooler here, which is why
this goes through PostgREST with the service key that is already on disk.

`backup.sh` widens `PATH` before calling node. launchd starts jobs with only
`/usr/bin:/bin:/usr/sbin:/sbin`, and node lives in `/usr/local/bin`; without the widening the agent
fails with `exec: node: not found` while the script works by hand. Check `~/supabase-backups/backup.log`
rather than assuming the agent is fine; a failed run leaves yesterday's tarball sitting there looking
current.

## The Supabase key

`client.ts` reads `SUPABASE_KEY` from the environment, falling back to a gitignored `.env` beside the
package so one-off `node -e` scripts work. Callers that set it themselves — the Fly app from secrets,
the voice worker from its own `.env`, the MCP from its launch config — are unaffected.

It is the **service_role** key: it bypasses RLS entirely, so anything holding it can read and write
every table.
