# data-layer

Everything that reads or writes Jared's life data goes through here. Supabase is the store; this is
the only thing that talks to it directly, so behaviour lives in one place rather than in each caller.

Two entry points over the same modules:

| | what | who runs it |
|---|---|---|
| `dist/mcp.js` | 53 MCP tools | every Claude session, Mac and Pi, via `~/.claude.json` |
| `dist/http.js` | JSON API on `:27186` | `data-http.service` on the Pi; the Mac calls it |

Both run from `dist/`; `pull-repos` rebuilds after pulling, so a change made on one machine reaches
the other's sessions within about fifteen minutes. `CLAUDE.md` covers what to know before editing.

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

`shopping_items` is the saved retailer catalogue: `retailer, item_id, name, default_qty,
last_verified`. Three MCP tools cover it — `get_shopping_items` (read it whole; it is small and has
no search), `build_walmart_cart_url` (ids + quantities -> one URL that fills the cart in a single
navigation), and `save_shopping_item`. Quantities ADD to the cart, so pass deltas. The catalogue
holds only what Jared has actually bought: an item found by search and put in a cart is not saved,
so `build_walmart_cart_url` refuses it and the affiliate URL is built by hand.

Amazon has no cart URL — its documented `/gp/aws/cart/add.html` was tested and adds nothing — so an
Amazon row saves the search, not the session.

`url` takes ids because reading `list` and choosing one is the step that picks the right product.
An earlier version matched on names and had to reject "milk" as ambiguous against a milkshake
cereal — a failure mode that only existed because of the matcher.
| `reviews.ts` | as named |
| `desk.ts` | dispatching Claude sessions to a machine, and the follow-up pointer |
| `reports.ts` | the HTML write-ups a dispatched session publishes |
| `helpers.ts` | ids, validation, and the clock — read it before using `now()` |
| `client.ts` | the Supabase client and where its key comes from |

## There is no reminders table, and no notes table

A reminder is a list item with a `due` date. Any item on any list, dated, fires and badges
identically; nothing distinguishes a "reminder" from a dated grocery item, and there is no tool
named for one — `add_to_list` with a `due` is how you create one.

**`list_items.alarm` is the one exception to "dated items are all alike."** A dated item notifies; a
dated item with `alarm` RINGS, through silent mode and through a Focus, because the phone registers it
with iOS 26's AlarmKit (the hub serves those items at `/api/alarms`; status-hub's `docs/TODO.md` has
the mechanism). It is false by default and nothing infers it — not priority, not wording — because a
soup timer should wake the room and an errand at 2am should not.

`add_to_list` takes `alarm`, `set_alarm` turns it on or off afterwards, and every list line prints
`[alarm]` so a reader can tell which of his dated items will wake him. Both tool descriptions refuse
to infer it, the same way `priority` does and for a sharper reason: a wrong guess here wakes a room,
and nothing on any surface says a guess was made. The hub's `POST /api/todos/alarm` is the same
switch from the other side.

## A list is addressed by its ID

`lists.id` is the key ('l_grocery'), and `list_items.list_id` is the reference. The name is a label:
editable, and not what anything points at. Renaming a list moves no rows.

That exists to make a wrong list REJECTABLE. While the name was the key, `add_to_list` had to accept
any string, because "a name not in the table" was the only way to say "start a new list" — so a typo
and an intention were the same request and the server always resolved it as create. `groceries`
against a stored `grocery` silently forked, and the items went somewhere nobody looks.

Two verbs now, and the split is the fix:

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
reading the list — and any other item carrying a body, like an Amazon row with a part number, stopped
hiding it at the same time.

Recurrence is materialised rather than stored (migration 00085). `repeat_every` on `add_to_list` is
an instruction executed once: it writes one dated row per occurrence out to `repeat_until`, all
sharing a `series_id`. There is no repeating item — checking one off leaves the rest alone, and a
skipped week is seven separate misses. `remove_from_list` with `series` clears what is left of one.

COMPLETING a dated item is the scoring event, and deleting one is not. `complete_item` stamps
`completed_at` and the row stays as a record of something that happened; `remove_from_list` takes it
away and is worth nothing in either direction. The hub reads `completed_at` off the row to draw the
gold band on its health bar: on time earns, late earns less and eventually costs, and anything left
sitting overdue drains for as long as it sits. Nothing mediates that — `task_events` and its trigger
were dropped in `00089` once a completed row became its own record.

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

## Migrations

Numbered SQL in `supabase/migrations/`, applied with `./migrate.sh` from whichever machine wrote them
— both have the CLI authenticated and the project linked. Never edit an applied migration; add
another.

    ./migrate.sh            # push, then list what is applied

## Backups

Supabase is the only copy of every life table, so `./backup.sh` writes a second one to the Mac:

    ./backup.sh                 # -> ~/supabase-backups/supabase-YYYY-MM-DD.tar.gz  (~2.6MB)

One `.jsonl` per table plus a `_manifest.txt` row count, driven off the PostgREST OpenAPI root so a
new table is picked up without touching this script. A daily launchd agent
(`com.jaredgantt.supabase-backup`, 04:15) runs it on the Mac, which then rsyncs the whole directory
to `pi:~/supabase-backups`. Three copies: Supabase, Mac, Pi.

The mirror is best-effort and says so in the log — the Mac cannot always reach the Pi, and a backup
that succeeded locally must not report failure because the mirror did not run. Mirroring the
directory rather than the day's file means the Pi inherits the same retention automatically.

**Data only — no schema.** That is not an omission: the schema is `supabase/migrations/`, which is
in git and better protected than a tarball. A restore is `./migrate.sh` to rebuild the schema, then
load the rows. The gap to know about is anything created in the Supabase dashboard and never written
as a migration — that exists in no backup at all.

Retention keeps every 1st-of-month dump forever plus the last 14 of anything else, so the archive
grows about 50MB a year rather than 1GB. The tarball is listed with `tar tzf` before it replaces
anything, because a truncated backup nobody opens until they need it is worse than none.

`pg_dump` is not on either machine and `supabase db dump` hangs against the pooler here, which is why
this goes through PostgREST with the service key that is already on disk.

`backup.sh` widens `PATH` before calling node. launchd starts jobs with only
`/usr/bin:/bin:/usr/sbin:/sbin`, and node lives in `/usr/local/bin` — the agent failed every run with
`exec: node: not found` while the same script worked by hand. Check `~/supabase-backups/backup.log`
rather than assuming the agent is fine; a failed run leaves yesterday's tarball sitting there looking
current.

## The Supabase key

`client.ts` reads `SUPABASE_KEY` from the environment, falling back to a gitignored `.env` beside the
package so one-off `node -e` scripts work. Callers that set it themselves — the Fly app from secrets,
the voice worker from its own `.env`, the MCP from its launch config — are unaffected.

It is the **service_role** key: it bypasses RLS entirely, so anything holding it can read and write
every table.
