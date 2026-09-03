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

`shopping_items` (read it with `cart.mjs`, not an MCP tool — see below) is the saved retailer catalogue:
`retailer, item_id, name, default_qty, last_verified`. Walmart fills a whole cart from one URL built
out of those ids; Amazon cannot, and the row only saves the search. See the Walmart section of
`~/.claude/CLAUDE.md` for the URL shape.

`cart.mjs` is a script for no principled reason — it is simply what was written first. An MCP tool
could do the same job, would reuse `client.ts` instead of re-parsing `.env`, and would work on the
Pi without assuming a checkout path. If it should move into the MCP, that is Jared's call:

    node cart.mjs list [walmart|amazon]
    node cart.mjs url 13893738=2 44390948=7
    node cart.mjs add walmart <item_id> "<name>" [category]

`url` takes ids because reading `list` and choosing one is the step that picks the right product.
An earlier version matched on names and had to reject "milk" as ambiguous against a milkshake
cereal — a failure mode that only existed because of the matcher.
| `notes.ts` `reviews.ts` | as named |
| `desk.ts` | dispatching Claude sessions to a machine, and the follow-up pointer |
| `reports.ts` | the HTML write-ups a dispatched session publishes |
| `helpers.ts` | ids, validation, and the clock — read it before using `now()` |
| `client.ts` | the Supabase client and where its key comes from |

## There is no reminders table

A reminder is a list item with a `due` date. Any item on any list, dated, fires and badges
identically; nothing distinguishes a "reminder" from a dated grocery item, and there is no tool
named for one — `add_to_list` with a `due` is how you create one.

`repeat_every` on an item makes it recur: when it fires, `due` advances and `scheduled_at` keeps the
original anchor, which is what the overdue badge counts.

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
