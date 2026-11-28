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
| `sessionTabs.ts` | `session_tab`: a session opens, updates and closes content tabs (an image, markdown, an HTML page) on its own view on his phone; `session_tabs` also holds the live Chrome tabs, claimed by status-hub `bin/chrome-live`. The design is status-hub `docs/SESSION-TABS.md` |
| `screenAgent.ts` | live screen shares on the Mac: answers a `screen_shares` row by starting `hands/bin/screenshare` (WebRTC, ScreenCaptureKit, hardware H.264, input as events); status-hub `docs/SCREEN.md` |
| `images.ts` | `share_image`: an image put in the `shared-images` bucket and shown inline in a reply (the hub serves `/img/<name>`) |
| `bedroomTv.ts` | the bedroom TV (`bedroom_tv`, table `tv_commands`): inserts a command and awaits the TV's answer. The hub relays it to the TV's app; google-tv `docs/VOICE.md`. Also `played`, the play log (table `tv_plays`, written by the hub from the TV app; google-tv `docs/WATCHING.md` § The play log) |
| `switchbot.ts` | the front door (`front_door`): a SwitchBot Lock Ultra + Keypad Touch on a Hub Mini, through SwitchBot's cloud Open API v1.1 — status, lock, unlock, history. Runs on any machine; history is table `door_events`, written by the Bluetooth listener (`door/`) through `door_report()`. § The front door |
| `roomba.ts` | the Roomba i7+ (`roomba`): status, whole-house and room/zone cleans with per-clean passes and edge clean, the saved cleaning preferences, pause/resume/stop/dock/empty, over the robot's LOCAL MQTT (no iRobot cloud). A home-network job (`home_requests` kind `roomba`, below); home-map rooms and zones in table `roomba_rooms`. § The Roomba |
| `feeder.ts` | the cat feeder (`feed_cats`, table `feeder_commands`): inserts a feed and awaits the Pi's `petlibro-collector` marking it done or failed. The feeder is LAN-only, so this relay is how a worker off the LAN (Fly) feeds; petlibro-mcp `CLAUDE.md` |
| `youtube.ts` | public YouTube (`youtube` search / video / related / channel), parsed from the JSON YouTube embeds in its pages |
| `youtubeApi.ts` | the owner's YouTube account through the YouTube Data API (OAuth): subscriptions, liked, playlists, and the writes — like, subscribe, make and add to playlists (§ YouTube) |
| `youtubeAccount.ts` | the owner's YouTube account where the API has nothing (`youtube` history / home / subscription_feed / watch_later), signed in with a browser's cookies: the Pi's automation browser, or the Mac's on-demand one; also the fallback for the API's reads |
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
| `mac-screen` | the screen, cropped to the session's `region`, with `app` (its owner name as `hands windows` lists it) brought to the front first; the display captured is the one that app is on. A handoff is a view of the screen, not of a window: no window is chosen or raised. A system authentication dialog on screen (SecurityAgent's "wants to make changes", the Touch ID sheet; `hands dialog`) overrides this: nothing is brought forward while one is up, because that moves the keyboard focus out of the dialog and his typing lands in the window behind it, and the picture is framed on the dialog. An app with no window at all (Keychain Access between its prompts) shows the main display. `handoffs.window_id` (00216) is inert: nothing writes or reads it | `handoffMain.js` on the Mac (launchd `com.jaredgantt.handoff-agent`) |
| `mac-chrome` | his Chrome, found by pid (the main `Google Chrome` process with no `--user-data-dir`, since an on-demand second Chrome can be running and AppleScript's "Google Chrome" may mean either) and raised with `hands activate`, on the tab the requesting session's Chrome tools touched last (selected in that Chrome by pid, `hands chrome-tab`) (claude-config `chrome-tabs` record); with no record, its front window | the same |
| `pi-browser` | the Pi's automation browser, over CDP on :9223 | data-http on the Pi (`HOME_AGENT=1` turns it on; `HANDOFF_TARGETS` overrides) |

**He starts on the part that matters, and can pinch out to the rest.** Each screenshot is the whole
display (Mac) or viewport (Pi), stored as `full_image`, with `focus`: the session's `region` (fractions
of the screen or page) or, on the Pi, `selector` (that element plus a 24 px margin, followed as the
page changes), as fractions of it. The phone frames `full_image` on `focus`. `image` is the focus
cropped out (`cropPng` in `src/pngDiff.ts`) for the watch, whose Full/Crop toggle is the `view` action,
flipping `handoffs.whole`. A tap carries `full` when it was measured on `full_image`; it is placed in
the rectangle the newest screenshot showed, which the agent keeps in memory. It takes a fresh screenshot of every open handoff
when it starts, and an action on one with no screenshot held is dropped and answered with the screen as
it is now, so a restart never ends a handoff. A share asked while the agent restarts (nobody subscribed) is claimed and answered at start if it is under 20 s old. A restart does end every live screen share (its helper
dies with the agent), so restart it with `bin/restart-handoff-agent`, which waits until no share is open.

**A handoff nobody answers expires** 30 minutes (`HANDOFF_EXPIRE_MS`) after its last activity: when it
opened (or left the queue), his last action on it, or his last input through a screen share of the Mac
(`active_at`, which the screen agent writes and counts in `taps` / `typed`). It is cancelled with `expired: …`, its session is told like any other
end, and the expiry is counted as an occurrence. Screenshots are not activity, so the fresh ones taken at
start never keep a forgotten handoff alive. The timer is held in memory per handoff and re-armed at start.

**A session has one ask open at a time.** A new `request_handoff` from a session cancels its earlier asks
still open (`superseded: …`), and `drive_screen` `open` cancels its asks on that target: he answered the
old one some other way (at the Mac itself, usually) or the session moved on. An open one is cancelled
through the agent (a `cancel` action with `source` `session`), so it is what opens the next in the queue;
an end the session made itself is never sent back to it as a follow-up. Without this every re-ask stays
on his phone until it expires.

**At start the agent applies the same rules to asks left across the restart** (open and queued): each
session's newest only, then the newest per screen in front, the rest queued.

**A screen takes one ask at a time.** The Mac's display has one keyboard focus, so another session's ask
open there (its keychain dialog holding the focus) would take his typing. An ask made while another is
open on the same screen (both Mac targets are one screen) is `queued`: no screenshot, no push, and
`request_handoff` answers that it is queued. Only an ask he is working on holds the line: one with no
activity for `HANDOFF_ACTIVE_MS` (2 min; an action, screen-share input, or being opened) goes back to the
queue and the new one opens, because a forgotten ask holding the screen means the one he is waiting for
never reaches his phone. When the open one ends however it ends, `tellSession` opens
the oldest queued one, which is when it is pushed. A session's own drives never queue. The agent also retires a session's other waiting asks whenever that session's new one arrives, so a session whose tools predate `supersede` obeys the rule too.

**Where his typing will go is read with every Mac screenshot** (`hands focused`: the front app's focused
field through Accessibility, which reaches a SecurityAgent dialog's fields too) and stored as
`typing_into` {label, secure, x, y, w, h}, the rectangle in fractions of `full_image`. The phone outlines
that field and names it on the Type button: a tap that lands a field away from where he aimed moves the
focus, and without this the next thing he types goes into a field he cannot see is focused.

`suggest` ([{label, text}]) on the request is values he will type that the session knows (his email, a
card number): buttons on the phone that fill his text box. Never a password or a one-time code; the
agent clears it when the handoff ends.

**A tap, typing or key is acted on only if the screen still matches the screenshot he made it on.** The
agent captures the screen again first; if the window moved or resized, or more than
`HANDOFF_CHANGED_FRACTION` (5%) of its pixels changed (`src/pngDiff.ts`), nothing is done, the action
is marked `the screen changed`, and he is sent the screen as it is now. The tolerance passes a blinking
caret or a small animation; a scrolled, navigated or covered page is stopped. On the Mac the window is
brought to the front before every action, since another app may have come forward since the screenshot.

A screen exists on one machine, so there is no fallback: a handoff whose machine is down is never
claimed, and `sweepMissed` reports it.

**Tables:** `handoffs` (the screen, its newest screenshot and `seq`, status `new → (queued →) open → done |
cancelled | failed`) and `handoff_actions` (each tap, text, key, refresh, done, cancel). Typed text is in
`handoff_actions.text` only until the agent has typed it; it is then nulled, and the session is told only
how many times he typed.

**The Mac needs two grants on `hands/bin/hands-launch`:** Screen Recording (window captures and titles)
and Accessibility (posting the click and keys). macOS ties a grant to the binary's signature, so
`hands/build.sh` builds the launcher only when it is missing; rebuilding it voids both grants. `hands`
(`hands/hands.swift`) is rebuilt freely: it runs as the launcher's descendant and uses its grants.

## Driving a screen

One of the capabilities in the shared `~/CLAUDE.md` § What each machine can do (claude-config `shared/CLAUDE.md`), which lists the rest.

`drive_screen` lets a session work a screen itself, from any machine, the Fly machine included: the
Mac with one app in front (`mac-screen`, `app: "Terminal"` to run a command there), his Chrome on the
Mac (`mac-chrome`, signed in to every account), or the Pi's automation browser (`pi-browser`). It is how
work that needs the Mac gets done when the session cannot run on the Mac, for example renewing the
Mac's Claude login from Fly when that login has expired.

It rides the handoff machinery: `open` inserts a `handoffs` row with `driver = 'session'`, and each
`tap` / `type` / `key` / `look` inserts a `handoff_actions` row and returns the agent's next
screenshot, as an image. `close` ends it, and the session must close what it opens (an unclosed one
expires after 30 minutes like any handoff). The differences from `request_handoff`:

- **Jared is pushed but not asked.** The hub sends the usual handoff push, so he sees a session working
  that screen and can watch it; its note says what the session is doing. Nothing waits on him.
- **A session ends its own handoff when it can see the step is done** (`drive_screen` `close` with the
  handoff's id, allowed for any handoff whose `session` is the caller's): a sign-in script that writes its
  file, a page that moves on. Asking him to press Done is only for a step whose end nothing can detect.
- **Handing him a screen the session is already driving reuses it.** `request_handoff` on the same
  target (and app) as this session's open drive converts that row in place (driver cleared, the new note,
  framing and suggestions set, a refresh taken), so his phone shows one handoff for one screen, never a
  second copy of the drive. The session cannot drive it after that.
- **Its end is not reported to the session** (`tellSession` skips `driver = 'session'`), because the
  session closed it itself; reporting it read as "Jared finished".
- **`open` reports `idle_s`**, the seconds since the Mac last had input from him (`ioreg` `HIDIdleTime`,
  read before the first action posts input of its own). A few minutes or less means he is at it.
- A step on a screen that changed since the last screenshot is dropped and answered with the new
  screen, exactly as for his taps; the caller looks and retries.
- Keys are those `hands key` posts: enter, tab, backspace, escape. Anything else is typed text, or a
  command run in a Terminal.
- **A Terminal it opens is a window of its own, and closes when the drive ends** (closed, failed or
  expired). The agent records the new window's shell tty at `open` and, at the end, asks the Mac
  orchestrator to close it (`close_window`), because the agent has no Automation grant for Terminal.
  The orchestrator closes it only while nothing but the shell is running there.

**The same process answers live screen shares** (`screenAgent.ts`, table `screen_shares`): the phone's
WebRTC offer arrives as a row and `hands/bin/screenshare` (`hands/screenshare.swift`) answers it,
streams the display and posts the phone's input, under the same two grants. `hands/build.sh` fetches the
pinned WebRTC framework it links into `hands/vendor`. The whole design is status-hub `docs/SCREEN.md`.

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

**A row inserted while no channel is subscribed is still answered.** A channel only hears inserts made
after it subscribes, so a row written while the agent was starting or reconnecting is never pushed to it.
Each SUBSCRIBED reads the rows created in that gap (back to 30 s at most, `catchUpFrom`) that are still
unclaimed, and takes them through the same claim.

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
and password to `.env`, and replaces `roomba_rooms` with the named rooms and Clean Zones on the HOME MAP,
`app_settings.roomba_map`. The iRobot app also keeps maps of earlier homes; they stay in the app and are
never saved, so nothing can be cleaned against them. Moving to a new map means changing that setting,
and the script refuses when the setting names a map the app no longer has. Its first run
prompts for the iRobot login and stores it in `.env` (`IROBOT_EMAIL`, `IROBOT_PASSWORD`); after that it
runs unattended. The tool's `rooms` reads the saved list; `update_rooms` re-runs the script. Only named
rooms and zones are kept. A zone's id is numbered apart from the rooms' (both start low), so the tool
names them `r<n>` and `z<n>`, and the robot is sent region type `rid` or `zid` accordingly.

Cleaning preferences (`settings` / `set`) are the robot's own reported state: `noAutoPasses` +
`twoPass` (passes: auto/1/2), `openOnly` (edge clean off), `carpetBoost` + `vacHigh` (power), `binPause`.
`set` publishes them to the `delta` topic and answers once the reported state shows them; a preference
the robot does not report is refused. `start` and `clean_rooms` take `passes` / `edge_clean` for one
clean, sent as `params` on the start command (and on each region of a room clean, the shape the app
uses for room-specific settings). The robot does not report per-clean params back, so unlike everything
else that effect cannot be confirmed from its state.
Its discovery host is `disc-prod.iot.irobotapi.com`; the older `disc-prod.irobotapi.com`
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
by hand. There is one row per KIND of food, named generically ("bagels", not "everything bagels"), so he
never has to say which variety; a different variety or brand is a switch. A switch is `set_pantry_item` with `replaces`, which retires the old row (`retired_at`,
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

## YouTube

`youtube` reaches his account two ways. The Data API (`youtubeApi.ts`) answers `subscriptions`, `liked`,
`playlists` and `playlist`, and does every write (`like`, `unlike`, `subscribe`, `unsubscribe`,
`create_playlist`, `add_to_playlist`). Watch history, home recommendations, the subscription feed and
Watch Later are not in the API at all, so those are read through a signed-in browser
(`youtubeAccount.ts`, a `home_requests` job). An API read that fails falls back to the browser and is
reported, since it means the grant is broken on that machine.

The grant is an OAuth refresh token on the gmail-mcp OAuth client (Google Cloud project
`status-hub-507320`, YouTube Data API enabled, published to production so the token does not lapse
after 7 days). `node bin/youtube-authorize.mjs` mints one: it prints a consent URL, catches the
redirect on loopback and writes `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN`
to `.env`. Those three live in `.env` on the Mac and as Fly secrets on `jared-voice-worker`; the Pi's
`.env` needs them copied in once it is back on the network. Quota is 10,000 units a day; a read costs 1,
a write 50.

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

## The front door

`front_door` (`src/switchbot.ts`) drives the SwitchBot Lock Ultra on the front door through SwitchBot's
cloud (Open API v1.1), so it needs no home network and runs on Fly, the Pi or the Mac alike. The lock
and its Keypad Touch speak Bluetooth only; the Hub Mini near the door is what puts them on the cloud.
Without the hub online, every call fails.

- `status` reads the lock live: `lockState` (locked / unlocked / jammed), `doorState` (opened /
  closed, from the door-frame magnet calibrated in the SwitchBot app) and battery.
- `lock` / `unlock` read the state first (already there is answered as such), send the command, then
  read the status every 1.5s until the new state shows, about 5s in practice; not there after 15s is
  an error. This is a bounded check of the command's effect, from any machine; the row itself comes
  from the Bluetooth listener.
- `history` reads `door_events` (migration 00206), with which sources reported each change and how long
  after it was recorded (`door_event_sources`, below). SwitchBot's API has no history of its own; the
  app's log is not reachable from the API.

**Events come from the lock's own Bluetooth advertisements.** The Lock Ultra advertises its state
every second or two, in the clear (no key): `door/listener.py` scans passively on each machine near the
door (the Mac now, `com.jaredgantt.door-listener`; the Pi joins as an equal peer when it is back) and,
on each changed advert, calls Supabase's `door_report()` (migrations 00208, 00209). A change lands as a
row about two seconds after it happens. Manufacturer data (company 2409), as pySwitchbot's
`process_lock2` reads the Lock Ultra, verified live for the lock bits: `[6]` sequence (bumps on a
change), `[7]` bit 7 calibrated and bits 6-3 status (0 locked, 1 unlocked, 2/3 moving, 4/5 jammed),
`[8]` bit 4 door open, `[9]` bits 6-0 battery. The moving states are not recorded.

`door_report(source, lock, door, …)` is the ONE writer of `door_events`, for every source: `ble` (the
listeners), `command` (the hub's `POST /api/door`, the watch's toggle), `webhook` and `backstop` (the
hub, status-hub `server/routes/switchbot.js`). Under an advisory lock it compares the report to the
latest row and writes one row per value that changed, so a command and the advert of the same change,
or two listeners hearing one advert, are one row. A `ble` report whose sequence byte is older than the
latest `ble` row's is dropped (a slow listener's stale advert). It keeps `device_status` row
`front-door` current, battery merged rather than nulled. `test/db/door-report.test.mjs` holds the rules.

**Every report is also kept in `door_sightings`** (00211), duplicates included, so each source's
reliability and lag can be measured: `outcome` is `new` (it wrote the row), `duplicate` or `stale`, and
`lock_event` / `door_event` point at the `door_events` row holding what it reported. `sampled_at` is the
webhook's own `timeOfSample`. The backstop's 5-minute read is kept only when it wrote a row. View
`door_event_sources` gives, per change since sightings began, each source that heard it and the seconds
after the recorded row (`heard_by`); a source missing from a change is a change it never reported.
`door_events` stays the only thing anything acts on.

**Presence on the home network** (`presence/listener.py`, table `lan_joins`, 00214): a phone or watch
joining the Wi-Fi sends a DHCP Discover or Request, broadcast to the whole LAN. The listener runs
tcpdump on that traffic and writes every message, an event rather than a poll; it reports to the
responder as `presence-listener` and beats on a timer while tcpdump is alive. Mac: LaunchAgent
`com.jaredgantt.presence-listener` (plist in `presence/`, log `~/Library/Logs/presence-listener.log`),
on the door listener's venv; reading packets needs `presence/install-capture-access.sh` run once with
sudo (a LaunchDaemon that opens `/dev/bpf*` to `admin` at every boot). The Pi runs it too when it is
back (interface `wlan0`, `PRESENCE_IFACE` to override). The hub acts on the rows (status-hub
docs/DOOR.md § Arrival): which MAC is the phone or the watch is `app_settings.presence_devices`.

**Phone and watch over Bluetooth** (`presence/ble.py`, table `presence_events`, 00217): both advertise
every second or so behind rotating private addresses. On the Mac, which shares his iCloud account,
CoreBluetooth resolves those itself, so a scan with bleak's `use_bdaddr` reports them under their real
addresses (each device's Settings > General > About > Bluetooth; listed in `DEVICES`), no key needed.
Unheard for `AWAY_S` (180 s) is away; the next advert is an `arrive` row (with `away_s`), and going
quiet is a `leave` row. A device not yet heard since start is unknown, so a restart is never an
arrival. LaunchAgent `com.jaredgantt.presence-ble` (plist in `presence/`, log
`~/Library/Logs/presence-ble.log`), under `door/bin/door-launch` for the Bluetooth grant; reports as
`presence-ble`. The Pi has no such pairing and would need each device's identity key:
`presence/read-ble-irks.sh` (sudo) copies them from the Mac's System keychain (service `BluetoothLE`,
`Remote IRK`) into `~/.config/presence/irks.json`; the phone's is there, the watch's not yet, and no
Pi listener uses them yet.

The listener runs under `door/bin/door-launch` (built by `door/build.sh`, gitignored), a launcher with
an embedded Info.plist that holds the Mac's Bluetooth grant, so the grant does not ride on the venv's
interpreter. Without the grant CoreBluetooth answers "Bluetooth device is turned off"; the listener
reports Bluetooth unavailable once per outage and retries with backoff up to ten minutes. It beats to
the responder only while the lock's adverts are being heard, and reports when none has arrived for five
minutes. Resident memory, measured on the Mac: about 19 MB (Python with bleak) plus under 1 MB for the launcher.

The hub's backstop reads the lock every five minutes through the cloud; a change it finds that no
source recorded becomes a `backstop` row and is reported as an error, because every event path
missed it.

SwitchBot's webhook, one URL per account, points at the status hub's
`POST /api/switchbot/<SWITCHBOT_WEBHOOK_TOKEN>`. SwitchBot signs nothing, so the secret path segment is
the auth. SwitchBot accepts the registration (`queryDetails` shows it enabled) and the hub route records
a hand-made `changeReport` correctly, but SwitchBot sends nothing for this Lock Ultra: no request
reached the hub for keypad, manual or API locks and unlocks, or for the door opening and closing.
Others report the same for the Lock Ultra (OpenWonderLabs/SwitchBotAPI issues #407, #502). The route
stays in case SwitchBot starts delivering.

| variable | where |
|---|---|
| `SWITCHBOT_TOKEN`, `SWITCHBOT_SECRET` | the SwitchBot app: Profile → Preferences → About → tap App Version ten times → Developer Options. In `.env` on each machine, and Fly secrets on `jared-voice-worker` and `jared-status-hub` |
| `SWITCHBOT_WEBHOOK_TOKEN` | random; Mac `.env` and Fly secret on `jared-status-hub` |
| `SWITCHBOT_LOCK_ID` | optional; needed only once the account holds more than one lock |

`bin/switchbot-webhook` registers the hub URL with SwitchBot (replacing any other) and checks
SwitchBot reports it back. Rerun it whenever `SWITCHBOT_WEBHOOK_TOKEN` or the hub's address changes.

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
command fails over to (`desk-routing`), and the three
SQL functions that hold shared rules, `muscle_volume()`, `desk_sessions_state()` and `door_report()`. Transports and
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
