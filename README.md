# data-layer

Everything that reads or writes the personal life data (workouts, nutrition, lists, health) goes through here. Supabase is the store; this is
the only thing that talks to it directly, so behaviour lives in one place rather than in each caller.

Three entry points over the same modules:

| | what | who runs it |
|---|---|---|
| `dist/mcp.js` | the MCP tools | every Claude session, Mac and Pi, via `~/.claude.json` |
| `dist/http.js` | JSON API on `127.0.0.1:27186` (`DATA_HTTP_HOST` to widen; bearer `DATA_HTTP_TOKEN` on every request, JSON bodies only), and with `HOME_AGENT=1` the Pi's home-network jobs (below) | `data-http.service` on the Pi; its one caller is gmail-watcher's Walmart handler |
| `dist/homeAgent.js` | the Mac's fallback for those home-network jobs | launchd `com.jaredgantt.home-agent` on the Mac (`launchd/`) |

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
| `pantry.ts` | the products he keeps at home, with label nutrition (`get_pantry`, `set_pantry_item`, `remove_pantry_item`; table `pantry_items`) — see below |
| `reviews.ts` | as named |
| `surf.ts` | the forecast read (`get_surf`) and a surf alarm's conditions (`set_surf_alarm`, table `surf_alarms`). It only stores them: the hub decides and owns the alarm — status-hub `docs/ALARMS.md` |
| `location.ts` | where the user is and was (`get_location`): now = the freshest and the most precise recent fixes from the phone/watch history (`location_points`) and command fixes (`locations`); `at` or `from`/`to` = a timeline of stays and the fixes between them |
| `itemLocations.ts` | where his untracked things are kept (`set_item_location`, `get_item_locations`, `remove_item_location`; table `item_locations`): item → free-text location, one row per item, matched ignoring case only. `set_item_location` requires the `seen` token `get_item_locations` returns (a hash of the saved names), so a write is refused unless the caller has read every saved name — that read is what stops 'my passport' becoming a second entry beside 'passport'. Not his own position, which is `location.ts` |
| `places.ts` | names for positions from the Apple Maps Server API (address + the business there), cached in `place_names`; needs `MAPS_KEY_ID`, `MAPS_PRIVATE_KEY`, `MAPS_TEAM_ID` on every machine that runs the MCP |
| `desk.ts` | dispatching Claude sessions to a machine, and the follow-up pointer |
| `reports.ts` | the HTML write-ups a dispatched session publishes |
| `handoff.ts`, `handoffAgent.ts` | `request_handoff`: a session hands Jared the screen it is stuck on (§ Handoffs) |
| `images.ts` | `share_image`: an image put in the `shared-images` bucket and shown inline in a reply (the hub serves `/img/<name>`) |
| `bedroomTv.ts` | the bedroom TV (`bedroom_tv`, table `tv_commands`): inserts a command and awaits the TV's answer. The hub relays it to the TV's app; google-tv `docs/VOICE.md` |
| `roomba.ts` | the Roomba i7+ (`roomba`): status, whole-house and per-room cleans, pause/resume/stop/dock/empty, over the robot's LOCAL MQTT (no iRobot cloud). A home-network job (`home_requests` kind `roomba`, below); room names in table `roomba_rooms`. § The Roomba |
| `feeder.ts` | the cat feeder (`feed_cats`, table `feeder_commands`): inserts a feed and awaits the Pi's `petlibro-collector` marking it done or failed. The feeder is LAN-only, so this relay is how a worker off the LAN (Fly) feeds; petlibro-mcp `CLAUDE.md` |
| `youtube.ts` | public YouTube (`youtube` search / video / related / channel), parsed from the JSON YouTube embeds in its pages |
| `youtubeAccount.ts` | the owner's YouTube account (`youtube` history / home / subscriptions / …), signed in with a browser's cookies: the Pi's automation browser, or the Mac's on-demand one |
| `ytParse.ts` | YouTube's renderer JSON, old and new shapes, flattened to rows; shared by the two above |
| `tvGuide.ts` | the bedroom TV's TV Guide (`tv_guide`, tables `tv_shelves` and `tv_shelf_items`): titled shelves of items, read by the TV through the hub's `/api/tv/guide`; google-tv `docs/GUIDE.md` |
| `catalog.ts` | what is streaming where (`catalog`), from JustWatch, with Android TV deep links |
| `appleMusic.ts` | his Apple Music account (`apple_music`): library, playlists, recent plays, catalog search, and adding songs, albums, favorites and playlists; needs the `APPLE_MUSIC_*` variables (§ Apple Music) |
| `homeRequests.ts` | reads only a machine at home can answer (table `home_requests`): any machine asks, the Pi answers, the Mac if the Pi does not |
| `tvHome.ts` | the bedroom TV's home-network end (the Pi, the Mac as fallback): power over Wake-on-LAN and adb, remote keys over adb, and a wake before `open` / `launch` / `input` |
| `realtime.ts` | `onInserts`, the reconnecting INSERT subscription the home jobs run on, with the fallback's deferred claim |
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

## Handoffs

A session stuck on something only Jared can do (a sign-in, a 2FA code, a captcha) calls
`request_handoff(target, note)`. He gets the screenshot on his phone and watch (status-hub
`docs/HANDOFFS.md`); where he taps is clicked on the real screen, what he types is typed there, and a new
screenshot follows each action until he presses Done or Cancel.

**Nothing waits for him.** The tool call returns once the screenshot is up and the session ends its
turn. When the handoff ends (Done, Cancel, or a failure), the agent sends the session a follow-up
starting `[Handoff <id>]` saying how it ended (`tellSession` in handoffAgent.ts), and that message starts
its next turn. A call held open until he finished is the attractive design and it fails: Claude Code
kills a tool call silent for 30 minutes, which leaves the handoff open with nobody behind it. Only a
caller with no `HUB_SESSION_ID` (no session to wake) still waits for the end.

| target | the screen | answered by |
|---|---|---|
| `mac-screen` | one app's front window (`app`, its owner name as `hands windows` lists it), on whichever display | `handoffMain.js` on the Mac (launchd `com.jaredgantt.handoff-agent`) |
| `mac-chrome` | Chrome's front window on the Mac, brought to the front (the Claude extension's tabs included) | the same |
| `pi-browser` | the Pi's automation browser, over CDP on :9223 | data-http on the Pi (`HOME_AGENT=1` turns it on; `HANDOFF_TARGETS` overrides) |

**Only the part that matters is sent** (he may be on the watch): a window, never a whole display, and
the session can crop further with `region` (fractions of the window or page) or, on the Pi, `selector`
(that element plus a 24 px margin, followed as the page changes). His Full/Crop toggle is the `view`
action, which flips `handoffs.whole`. A tap is placed in the rectangle the newest screenshot showed,
which the agent keeps in memory: after an agent restart a tap fails until Refresh takes a new one.

**A tap, typing or key is acted on only if the screen still matches the screenshot he made it on.** The
agent captures the screen again first; if the window moved or resized, or more than
`HANDOFF_CHANGED_FRACTION` (5%) of its pixels changed (`src/pngDiff.ts`), nothing is done, the action
is marked `the screen changed`, and he is sent the screen as it is now. The tolerance passes a blinking
caret or a small animation; a scrolled, navigated or covered page is stopped. On the Mac the window is
brought to the front before every action, since another app may have come forward since the screenshot.

A screen exists on one machine, so there is no fallback: a handoff whose machine is down is never
claimed, and `sweepMissed` reports it.

**Tables:** `handoffs` (the screen, its newest screenshot and `seq`, status `new → open → done |
cancelled | failed`) and `handoff_actions` (each tap, text, key, refresh, done, cancel). Typed text is in
`handoff_actions.text` only until the agent has typed it; it is then nulled, and the session is told only
how many times he typed.

**The Mac needs two grants on `hands/bin/hands-launch`:** Screen Recording (window captures and titles)
and Accessibility (posting the click and keys). macOS ties a grant to the binary's signature, so
`hands/build.sh` builds the launcher only when it is missing; rebuilding it voids both grants. `hands`
(`hands/hands.swift`) is rebuilt freely: it runs as the launcher's descendant and uses its grants.

**The screenshot after an action waits `HANDOFF_SETTLE_MS` (1.2 s).** No event says a screen has
finished changing after a click; a result still in motion is what the Refresh action is for.

## The home-network jobs

Some things only a machine on the home network can do: wake the bedroom TV (Wake-on-LAN, adb), read
the owner's YouTube account through a browser signed in as him, or drive the Roomba. The voice worker usually runs on Fly,
which can do neither. So the caller writes a row (`tv_commands`, `home_requests`) and a machine at
home, subscribed to inserts, does the work and fills in the answer. Realtime both ways; nothing polls.

**The Pi answers; the Mac answers what the Pi does not.** Every row is claimed before it is acted on
(`claimed_by`, set by `onInserts` in `realtime.ts`). The Pi claims at once. The Mac's home agent
(`dist/homeAgent.js`) waits `HOME_DEFER_MS` (4 s) before claiming, so while the Pi is up it always finds
the row taken and does nothing; a row it does win means the Pi is down, and it reports that as an
error. The Mac answers only while it is awake.

**A row nobody claims is reported.** Every row is claimed by whichever machine answers it, so one still
unclaimed after a minute means no machine heard it: the realtime channel went deaf, or every agent was
down. Each agent sweeps for those every 10 minutes (`sweepMissed` in `realtime.ts`), claims each as
`<host>:missed` so it is reported once, and reports it as an error. It never acts on them; a TV command
minutes late is worse than none.

**A channel that hears nothing is recycled.** A realtime channel can report SUBSCRIBED and deliver
nothing, and a deaf Mac behind a healthy Pi leaves no unclaimed row to find. So each agent's sweep also
lists the rows inserted since its channel subscribed and compares them with the ids it actually received
(`sweepUnheard`); any it never got is reported as `channel deaf while SUBSCRIBED` and the channel is torn
down and rejoined.

- **Pi**: inside data-http, so it costs one realtime socket and no extra process; data-http measures
  about 75MB resident with it on. Switched on by `HOME_AGENT=1` in
  `/etc/systemd/system/data-http.service.d/home-agent.conf`.
- **Mac**: launchd `com.jaredgantt.home-agent`, from `launchd/com.jaredgantt.home-agent.plist`
  (copy it to `~/Library/LaunchAgents` and `launchctl bootstrap gui/$(id -u)` it). Log
  `~/Library/Logs/home-agent.log`; it reports to the ops responder as `mac/home-agent`.
  `pull-repos` restarts it after a data-layer rebuild.

Every TV job works the same from the Mac (`bin/tv` reaches the TV over wireless adb from either
machine) except `sleep`, whose timer is a systemd unit: the Mac answers that one with an error.

YouTube on the Mac is a **dedicated Chrome profile**, `~/browser-profiles/youtube`, not his everyday
Chrome: that one's cookies are encrypted under the login keychain, and reading them means reaching
into every site he is signed in to. The profile was signed in to his Google account once by hand.
The agent starts it headless on demand (DevTools on `127.0.0.1:9225`, `--use-mock-keychain` so its
cookies never touch the keychain) and quits it after ten idle minutes. To sign in again, quit that
headless Chrome and open the profile with a window:

    open -na "Google Chrome" --args --user-data-dir="$HOME/browser-profiles/youtube" --use-mock-keychain \
      --remote-debugging-port=9225 --no-first-run https://accounts.google.com/

Only one Chrome can hold the profile at a time, so while that window is open the agent uses it rather
than starting its own.

## The Roomba

`roomba.ts` opens a TLS MQTT connection to the robot for each request (port 8883, username and client
id = its BLID), reads the state it pushes on connect, publishes to `cmd`, then waits for the robot's own
`cleanMissionStatus` to show the effect: a command that is published but never takes effect is an
error, not a success. Nothing stays connected between requests.

`dock` during a running or paused clean is acknowledged by the robot and ignored, so the tool sends
`stop` first, waits for the robot to report it stopped, then sends `dock`.

Each machine that answers needs `ROOMBA_IP`, `ROOMBA_BLID` and `ROOMBA_PASSWORD` in its
`data-layer/.env`. The IP is DHCP; when it stops answering, the robot is found again by its UDP
discovery broadcast (`irobotmcs` to port 5678) and the error log says to update `ROOMBA_IP`.

The local password comes only from the iRobot cloud: on this firmware (lewis 22.x) the robot answers
the local password request with "cloud only", so the hold-HOME method that roombapy and dorita980
describe does nothing. `python3 roomba/fetch-cloud.py` signs in to the iRobot account, writes the BLID
and password to `.env`, and replaces `roomba_rooms` with the rooms on every visible map. Its first run
prompts for the iRobot login and stores it in `.env` (`IROBOT_EMAIL`, `IROBOT_PASSWORD`); after that it
runs unattended. The tool's `rooms` reads the saved list; `update_rooms` re-runs the script, and only
when he asks for it, because rooms change rarely. Only named rooms are kept: a map never edited in the
app has unnamed segments and no user version. Its discovery host is `disc-prod.iot.irobotapi.com`; the older `disc-prod.irobotapi.com`
no longer resolves.

## JaredBot switch

`app_settings.jaredbot_enabled` is JaredBot's on/off switch (the hub's Settings and the voice
`set_jaredbot` tool write it). Off means the `com.jaredgantt.jaredbot` launchd job is not running, so
nothing reads chat.db. The Mac's home agent enforces it (`src/jaredbotSwitch.ts`, Mac only). It watches
that row over realtime, starts the job when the switch turns on and stops it when the switch turns off,
and re-applies the switch every 10 minutes as the backstop. JaredBot's own repo README covers what
the bot does on either side of a switch.

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

## A dispatch goes to the next machine, never into a wait

Every desk command (`desk.ts`) goes to a machine that can take it NOW, in `failoverOrder`: the machine
asked for (or the session's own), the other home machine, then Fly, woken through `/wake`. A machine is
passed over when it is not beating or not signed in, when it refuses the command, and when it has not
claimed it within `CONFIRM_MS`. A silent machine's command is taken back first (`cancelPending`: an
update that only matches `status=pending`), so it cannot also run there; one that claimed it in that
moment keeps it, and the tool says it is running but unconfirmed. A `handed to the Mac|the Pi|Fly as
<id>` verdict is followed to that command. Only when Fly fails too is the work dead-lettered, with a
`console.error`.

A session whose machine is not answering moves rather than waits: `follow_up`, `resume_session` and
`transfer_session` resume its mirrored conversation elsewhere (`resumeMirrored`), which first claims the
source row as `transferred` — the same atomic write the responder's evacuate makes, so only one mover
resumes a conversation — and puts the row back if no machine takes it. A session that cannot move (Codex,
or nothing mirrored) gets its words started as a new session in its repo. `end_session` for a machine
that is not there closes the row itself, parked when it has a transcript.

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

- **The schema is built once per session**, so creating, moving or deleting a list makes it stale. All
  three send `notifications/tools/list_changed`, and the server advertises `tools.listChanged`.
- **`list_items.list_name` is DERIVED**, filled by the `list_items_resolve_list` trigger from
  `list_id` — the same arrangement as `sets.exercise` and `exercise_id`. Read it, never write it. It
  is still there because the hub draws it on every list surface.

The database enforces this independently of any caller: that trigger resolves a name-only write to an
id and RAISES when it cannot, so a fork is not reachable even by writing to PostgREST directly.

## Lists inside lists

`lists.parent_id` (00184) nests a list inside another; null is top level. Only LISTS nest: an item
belongs to exactly one list by `list_id`, so scoring, the due view and the calendar never see the tree.

- `create_list` takes an optional `parent_id`; `move_list` re-parents an existing list (omit
  `parent_id` for the top level). The roster in every list tool's description names each list's
  parents, and `get_lists` prints lists in tree order with the full path in each header
  (`listTree` / `listPath` in `lists.ts`).
- A cycle is refused by the `lists_no_cycle` trigger, so it cannot be written by any route.
- `delete_list` keeps the sublists and moves them up to the deleted list's own parent. The FK is
  `on delete restrict`, so a delete that skips that step fails rather than taking the sublists with it.

A note is a list item with a BODY: an undated row on the `notes` list, its short name in `title` and
its full text in `text` (migration 00092). It has no tools of its own. `get_lists` prints an
item's `text` indented under the label whenever the two differ, so reading a note back is just
reading the list — and any other item carrying a body, like an Amazon row with a part number, shows it
the same way.

`edit_item` changes an item's `title` and `text` in place, so a note is edited rather than removed
and re-added — which would lose the row's id and creation time and, for a dated item, its series,
completion and score. It edits one row: a series occurrence is changed alone.

An item can hold audio (migration 00186): `list_items.recordings` is an array of `{path, type, dur, at,
request_id, start_s}`, the files in the private `list-audio` bucket, which no retention sweep touches.
`save_recording` (`src/recordings.ts`) keeps the audio of the voice command being answered: it reads
the in-flight request id from the file `DATA_REQ_FILE` names (written by the voice worker per command,
a file for the same reason as `DATA_TS_FILE`) and asks the hub's `/api/list-recordings` to do the work,
so it needs `HUB_TOKEN` (and optionally `HUB_URL`) in its environment. The hub cuts the clip at the end
of the start marker the model names (`after`, usually "starting now") using Whisper word timings,
because only the hub has the Groq key and ffmpeg. A marker not found answers the timed words, and the
model calls again with `start_s`. Only phone and watch commands keep a clip, so only they can be saved.

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

## The pantry: his own products, at home only

`pantry_items` is one row per product he keeps: `names` (what he calls it, "yum yum sauce"), the brand
`product`, and the label's nutrition per serving (`serving_amount serving_unit`, `serving_g` when the label
prints a weight). A food-writing tool (log, stage, both edits, `save_recipe`) takes an ingredient as
`pantry_id` + amount + unit, and `applyPantry` replaces it with the label macros scaled to that portion:
the label's own unit, any volume to a volume label, any weight to a weight label or through `serving_g`,
or `serving`. Units that cannot be related are refused rather than given an invented density.

The brands apply only AT HOME. `get_pantry` answers with whether he was home at the moment he ate (`at`,
else now): the last location fix at or before it (`location.fixAt`), home within `HOME_RADIUS_M` of the
`app_settings.home_location` row ("lat,lon", set directly and never committed, since this repo is public;
change it when he moves). Away, its text tells the model to log a generic estimate unless he named the
brand. No fix at all counts as home, and the reply says the brand was assumed. Every food tool's
description leads with `PANTRY_NOTE` (mcp.ts), which is what makes the logger call `get_pantry` at all.

Rows are added at CART time by the Walmart/Amazon sessions (the `shopping` skill), since checkout is done
by hand. A brand switch is `set_pantry_item` with `replaces`, which retires the old row (`retired_at`,
`replaced_by`) instead of editing it. Every write answers `PANTRY CHANGED — tell Jared…`, so the change
reaches him in that session's reply.

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

## Place names

`get_location` names positions through the Apple Maps Server API (`src/places.ts`), reachable from all three
machines over plain HTTPS. Each needs three variables in the environment the MCP runs in:

| variable | value |
|---|---|
| `MAPS_TEAM_ID` | `XMH4AVFC78` |
| `MAPS_KEY_ID` | `2K8C7JS7ZS`, the "Location Maps" key in the developer account (Keys), tied to Maps ID `maps.com.jaredgantt.location` |
| `MAPS_PRIVATE_KEY` | that key's `.p8` on one line, newlines written as `\n`, **unquoted** (the `.env` loader keeps quotes literally, and a quoted PEM fails to parse) |

They live in `.env` on the Mac and the Pi and as Fly secrets on `jared-voice-worker`. The `.p8` itself is in
`~/.appstoreconnect/private_keys/` on the Mac; Apple lets it be downloaded only once. Without the variables,
answers carry coordinates only and `[places]` logs an error.

Lookups are cached by position (4 decimal places, about 11 m) in `place_names` for every machine. A cached
miss is permanent, so after changing how `lookUp` works, delete the table's rows to re-ask Apple.

## Apple Music

`apple_music` (`src/appleMusic.ts`) reads and adds to his Apple Music library through the Apple Music API.
The API itself cannot delete or rename anything in a library, so the tool only adds. It cannot play
anything either; playback on the HomePods is Siri's.

| variable | value |
|---|---|
| `APPLE_MUSIC_TEAM_ID` | `XMH4AVFC78` |
| `APPLE_MUSIC_KEY_ID` | `96Y764WD88`, the MusicKit key "Jared Music" (Media ID `media.com.jaredgantt.music`) |
| `APPLE_MUSIC_PRIVATE_KEY` | that key's `.p8` (`~/.appstoreconnect/private_keys/` on the Mac) on one line, newlines as `\n`, unquoted |
| `APPLE_MUSIC_USER_TOKEN` | his Music-User-Token, `~/.config/music/apple-music-user-token` on the Mac |

They live in `.env` on the Mac and as Fly secrets on `jared-voice-worker`. **The Pi's `.env` does not have
them yet** (the Pi was off the network when the tool was added); until it does, `apple_music` on the Pi
answers that it is not configured and logs an error.

The user token can only be minted by MusicKit JS in a browser (`~/repos/music/bin/apple-music-login`,
which opens a page on the Mac) and lasts about six months. When it expires every call fails 401/403
after the retries, and the error says to sign in again; then copy the new token to every place above.
Apple also answers a burst of calls with 401 or 403 "Invalid authentication" while both tokens are
valid, clearing within a minute, which is why those statuses are retried with backoff rather than
treated as an expired token at once. Some responses arrive gzipped without a `Content-Encoding` header.

Catalog ids (numbers) are what adding, favoriting and playlists take; library ids (`i.`, `l.`, `p.`)
name what is already in the library, and library songs print their catalog id beside them. `recent`
is Apple's last ~90 tracks with no times; there is no fuller history in the API.

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
items, which completion times are honoured, the `now()` clock, the HTTP API's token gate, where a desk
command fails over to (`desk-routing`), and the two
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
connection or a 5xx with backoff (2s, 5s, 15s, 30s, then 60s three times; about four minutes) before
the run fails. When the Mac sleeps through 04:15, launchd runs it at the next wake, before DNS is up.

`backup.sh` reads only the `SUPABASE_*` lines of `.env`, literally. Sourcing the whole file as shell
breaks on `MAPS_PRIVATE_KEY`, which is an unquoted PEM with spaces in it.

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
