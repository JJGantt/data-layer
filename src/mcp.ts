#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'child_process';
import { hostname } from 'os';
import * as health from './health.js';
import * as appleHealth from './appleHealth.js';
import * as workouts from './workouts.js';
import * as nutrition from './nutrition.js';
import * as recipes from './recipes.js';
import * as lists from './lists.js';
import * as desk from './desk.js';
import * as reports from './reports.js';
import * as shopping from './shopping.js';
import * as surf from './surf.js';
import * as location from './location.js';
import * as bedroomTv from './bedroomTv.js';
import * as youtube from './youtube.js';
import * as catalog from './catalog.js';
import * as youtubeAccount from './youtubeAccount.js';
import * as homeRequests from './homeRequests.js';

const PRODUCE_TYPE_DESC = "Set ONLY for fruits and vegetables; pick exactly one, the three are mutually exclusive. 'dark_green_vegetable' is the USDA dark green vegetable subgroup, which is broader than leafy: alongside the dark leafy greens it includes broccoli, broccolini, Brussels sprouts, asparagus, green beans and green/snap peas. 'other_vegetable' is every other vegetable, including legumes, beans and starchy vegetables. 'fruit' includes avocado. Omit the field entirely for anything that is not a fruit or vegetable.";

const server = new Server({ name: 'data', version: '2.0.0' }, { capabilities: { tools: { listChanged: true } } });

// The `list` parameter is free text and an unknown name CREATES a list, so a near-miss ('groceries'
// for 'grocery') does not error — it forks a parallel list that later reads back empty. The names are
// therefore built into the schema at connect time rather than left to the caller to guess. This is the
// same move get_shopping_items makes for cart ids, for the same reason: the set is small, the caller
// can be handed all of it, and matching a string against it is a step that only invents failures.
//
// The enum is the enforcement; the prose only says which id is which.
//
// A list is addressed by `list_id`, never by its name (00094). That is what lets the schema CONSTRAIN
// the value: with the name as the key, "a name not in the table" was how a new list got created, so
// every string had to be accepted and a typo was indistinguishable from an intention. Creating is now
// `create_list` alone, which leaves the id field with a closed set — expressible as an `enum`, which a
// validating client rejects before the call is even sent, and which `requireList` rejects again
// server-side for clients that do not validate.
//
// Fetched per tools/list rather than cached: the handler runs once per session, and the ids are the
// whole vocabulary for that session.
async function listRoster(): Promise<{ ids: string[]; desc: string }> {
  try {
    const all = await lists.allLists();
    if (!all.length) return { ids: [], desc: `No lists exist yet — create_list makes the first one.` };
    return {
      ids: all.map(l => l.id),
      desc: `Which list, BY ID: ${all.map(l => `${l.id} = "${l.name}"`).join(', ')}.`,
    };
  } catch {
    // A roster that cannot be read must not take the tools down with it. No enum in that case, so the
    // server-side check in requireList is the only guard — which is why it exists.
    return { ids: [], desc: `Call get_lists for the list ids.` };
  }
}

/** A `list_id` property: the prose, plus the enum that actually enforces it. */
function listIdProp(roster: { ids: string[]; desc: string }, lead: string) {
  return {
    type: 'string' as const,
    description: `${lead} ${roster.desc}`,
    ...(roster.ids.length ? { enum: roster.ids } : {}),
  };
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const roster = await listRoster();
  return {
  tools: [
    { name: 'get_health_profile', description: 'Returns height, recent weight log entries, and current nutrition targets (calories, protein, carbs, fat).', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'get_location', description: "Where Jared last was: a lat/lon fix per device (watch, web), each with how old it is. Call it only when a request depends on where he is — 'near me', directions, a ride, local hours, the weather here — and never otherwise. It updates when he speaks to a device that has a fix, so check the age: hours old may no longer be where he is. Nothing here names the place; the coordinates are the answer.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'get_surf', description: "The surf forecast at Jared's break (Mayport Poles) from Surfline — rating, wave size, wind and swell at three-hour steps, when the forecast was captured, and the water temperature. Use this for surf there rather than web search: Surfline blocks bots, so the web does not have it.", inputSchema: { type: 'object' as const, properties: { days: { type: 'number', description: 'How many days ahead, 1-10. Omit for 2.' } } } },
    { name: 'set_height', description: 'Set or update height in inches.', inputSchema: { type: 'object' as const, properties: { height_in: { type: 'number', description: 'Height in inches (e.g. 72 for 6\'0").' } }, required: ['height_in'] } },
    { name: 'log_weight', description: 'Log a body weight entry. Appends to the weight log. ONLY call this with a weight the user EXPLICITLY stated as a number in their message. NEVER infer, estimate, guess, or fabricate a bodyweight, and NEVER back-fill multiple days from one request. If no explicit number was given — e.g. "log my weight" with no value, or a workout command like "add 10 rows body weight" (that is a SET of the Rows exercise, not a weigh-in) — do NOT call this tool; ask the user for the number instead.', inputSchema: { type: 'object' as const, properties: { weight_lbs: { type: 'number', description: 'Body weight in pounds — must be a value the user explicitly spoke.' }, date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' } }, required: ['weight_lbs'] } },
    { name: 'update_weight', description: "Correct a logged weigh-in by its id (shown in get_health_profile) — the number, the day it belongs to, or both. Use this when the reading itself is wrong ('that should have been 178, not 188') or landed on the wrong date, rather than removing it and logging it again: re-logging restamps when the reading was taken, which is what separates a morning weigh-in from an evening one. Both fields are optional and ONLY what you pass is changed, so fixing the number leaves the date alone. Call get_health_profile first for the id — never guess one, and never identify an entry by its date alone, because a day can hold more than one weigh-in.", inputSchema: { type: 'object' as const, properties: { id: { type: 'integer', description: 'Weight log entry id from get_health_profile.' }, weight_lbs: { type: 'number', description: 'Optional. The corrected body weight in pounds — a value the user explicitly stated, never an estimate.' }, date: { type: 'string', description: 'Optional. Move the entry to another day, YYYY-MM-DD.' } }, required: ['id'] } },
    { name: 'remove_weight', description: "Delete a weigh-in by its id (shown in get_health_profile). For a reading that should not be there at all — a duplicate, a number typed against the wrong person's scale, an entry the user says to get rid of. If the reading happened but the NUMBER is wrong, use update_weight instead; deleting and re-logging loses when it was taken. Call get_health_profile first for the id — never guess one, and never identify an entry by its date alone, because a day can hold more than one weigh-in.", inputSchema: { type: 'object' as const, properties: { id: { type: 'integer', description: 'Weight log entry id from get_health_profile.' } }, required: ['id'] } },
    { name: 'get_health_data', description: "Apple Health, as his iPhone mirrors it: everything the watch and phone record — heart rate, resting heart rate, HRV (heartRateVariabilitySDNN), blood oxygen (oxygenSaturation), respiratory rate, wrist temperature, VO2 max, steps, active/basal energy, exercise and stand time, walking metrics, audio exposure, workouts with their heart-rate and energy stats, and sleep. Read-only. Omit `type` FIRST to list every type that has data, with its unit and date span — the type names are HealthKit's (camelCase, e.g. `restingHeartRate`, `activeEnergyBurned`), so pick the exact name from that list rather than guessing. `type: \"sleep\"` gives one row per night (bed and wake time, asleep, core/deep/REM, awake). `type: \"workout\"` gives each workout with its stats. Any other type is rolled up PER DAY (count, avg, min, max, sum — sum is the figure for cumulative types like steps and energy, avg for rates like heart rate). Pass `readings: true` for the individual samples instead, e.g. heart rate across one workout; narrow the window, since heart rate is thousands a day. Days are New York calendar days. Data arrives when the phone syncs, so the newest hours may not be here yet.", inputSchema: { type: 'object' as const, properties: { type: { type: 'string', description: 'A type name from the no-type listing, or \"sleep\" or \"workout\". Omit to list what exists.' }, from: { type: 'string', description: 'First day, YYYY-MM-DD. Defaults to six days before `to`.' }, to: { type: 'string', description: 'Last day, YYYY-MM-DD, inclusive. Defaults to today.' }, readings: { type: 'boolean', description: 'True for individual readings rather than per-day rollups.' }, limit: { type: 'integer', description: 'Max readings with `readings`, default 500, cap 2000.' } } } },
    { name: 'get_nutrition_targets', description: 'Get the current daily nutrition targets (calories, protein, carbs, fat) and recent target history.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'set_nutrition_targets', description: 'Set daily nutrition targets (calories, protein, carbs, fat). Appends a new entry to the target log so history is preserved. The most recent entry becomes the current target, shown in get_health_profile.', inputSchema: { type: 'object' as const, properties: { calories: { type: 'number', description: 'Daily calorie target.' }, protein_g: { type: 'number', description: 'Daily protein target in grams.' }, carbs_g: { type: 'number', description: 'Daily carbs target in grams.' }, fat_g: { type: 'number', description: 'Daily fat target in grams.' }, date: { type: 'string', description: 'Date these targets take effect (YYYY-MM-DD). Defaults to today.' } }, required: ['calories', 'protein_g', 'carbs_g', 'fat_g'] } },
    { name: 'get_workout_catalog', description: 'Returns the valid categories (push/pull/legs/core/cardio), the valid muscle slugs, and the canonical exercise library — each exercise with its numeric id, categories and fractional muscle map. Call this before log_set / update_set / set_rep_watcher: those tools take the exercise ID, never a name, so this is where the id comes from. Match what the user said to an exercise here regardless of how they said it — plural, singular or casing ("overhead tricep extensions" is id for Overhead Tricep Extension) — and pass that id. Only treat a movement as genuinely new if nothing here is the same exercise.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'log_set', description: "Log one or more sets to today's workout, with the reps STATED BY THE USER. If the user gives an exercise and weight but NO reps because the watch will count them, use set_rep_watcher instead. There is no session — each set is its own timestamped row, stamped NOW unless the set carries its own `occurred_at`, which is how you log a set that already happened ('add the set I did at 1:50'). Pass a 'sets' array. Each set names its movement by `exercise_id` from get_workout_catalog — call that FIRST and match what the user said to an entry there however they phrased it (plural, singular, casing); the id carries the name and muscle map, so there is nothing to spell. For a movement genuinely not in the catalog, call upsert_catalog_exercise first (it returns the new id) and log against that. weight_lbs is TOTAL weight (a '30 lb dumbbell' pair = 60); bodyweight = 0. Log set-by-set as you train (accurate rest timing) or several at once. Returns today's workout table — pass it to the user exactly as-is.", inputSchema: { type: 'object' as const, properties: { sets: { type: 'array', description: 'Sets to log: [{exercise_id, weight_lbs, reps, optional occurred_at}].', items: { type: 'object', properties: { exercise_id: { type: 'integer', description: 'Numeric id from get_workout_catalog. Never a name.' }, weight_lbs: { type: 'number', description: 'Total weight in lbs; bodyweight = 0.' }, reps: { type: 'integer' }, occurred_at: { type: 'string', description: "Optional. When this set actually happened, as LOCAL wall-clock 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD' for a bare day, which lands at noon) — the clock reading where he was, never UTC. Omit for a set happening now, which is the normal case; sets logged together without it share one timestamp." }, note: { type: 'string', description: "Optional free-text note on this set — a grip, stance, tempo, how it felt ('pronated overhand grip'). Only what he said; omit when he gave none." } }, required: ['exercise_id', 'weight_lbs', 'reps'] } } }, required: ['sets'] } },
    { name: 'set_rep_watcher', description: "Set the REP WATCHER: from now on, every set counted by the Apple Watch app is logged as this exercise at this weight, with its own timestamp. Triggered by the phrase 'rep watcher' — 'set the rep watcher to incline press at 80' — call get_workout_catalog and pass that exercise's id. HOW TO TELL THIS FROM log_set: this tool takes NO reps, because the watch supplies them. A stated rep count ('log 8 reps of incline press at 80') is log_set, one set now. An exercise and weight with no reps, said before training, is THIS tool. Must be set BEFORE the sets happen; a set the watch reports while the watcher is off is discarded rather than guessed at. Clears itself after ten minutes with no set. Does not replace log_set, which stays the way to log by hand.", inputSchema: { type: 'object' as const, properties: { exercise_id: { type: 'integer', description: 'Numeric id from get_workout_catalog. Never a name.' }, weight_lbs: { type: 'number', description: 'TOTAL weight in lbs; bodyweight = 0.' } }, required: ['exercise_id', 'weight_lbs'] } },
    { name: 'get_rep_watcher', description: 'Show what the rep watcher is set to and whether it is still live, i.e. whether sets counted by the watch are currently being logged.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'clear_rep_watcher', description: 'Clear the rep watcher, so sets counted by the watch stop being logged.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'upsert_catalog_exercise', description: 'Create a new exercise in the catalog, or edit an existing one (fix its categories or muscle map). Provide name, categories, and a fractional muscles map ({slug: contribution}, 0 < c <= 1). Editing REPLACES the muscle map. Because volume joins to the catalog at read time, edits retroactively correct all history.', inputSchema: { type: 'object' as const, properties: { name: { type: 'string' }, categories: { type: 'array', items: { type: 'string', enum: ['push', 'pull', 'legs', 'core', 'cardio'] } }, muscles: { type: 'object', additionalProperties: { type: 'number' }, description: 'Fractional map, e.g. {"quads":1.0,"glutes":0.5}.' } }, required: ['name', 'categories', 'muscles'] } },
    { name: 'list_workouts', description: 'List recent workout days, newest DAY first — date, derived category label, start and end time, set count, and the exercises IN THE ORDER HE DID THEM (first to last, joined by →). Only the days run newest-first; within a day everything is chronological.', inputSchema: { type: 'object' as const, properties: { limit: { type: 'integer', description: 'Max days to return. Defaults to 10.' } } } },
    { name: 'get_workout', description: "Get a day's full workout — all sets grouped by exercise, exercises in the order he started them, then every set in the order done with its local time. Defaults to today. Returns a pre-formatted table — pass it to the user exactly as-is.", inputSchema: { type: 'object' as const, properties: { date: { type: 'string', description: 'Date YYYY-MM-DD. Defaults to today.' } } } },
    { name: 'get_exercise_history', description: 'Get progression history for a single exercise, newest DAY first. Within each day the sets run in the order done (first set first), each with its local time.', inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Exercise name (case-insensitive).' }, limit: { type: 'integer', description: 'Max days to return. Defaults to 60.' } }, required: ['name'] } },
    { name: 'get_shopping_items', description: "Jared's saved Walmart/Amazon items with their retailer item ids. Read this FIRST for any cart request — the id is what fills a cart, and choosing it off this list is what picks the right product. Small enough to read whole; there is no search.", inputSchema: { type: 'object' as const, properties: { retailer: { type: 'string', enum: ['walmart','amazon'], description: 'Optional filter.' } } } },
    { name: 'build_walmart_cart_url', description: 'Turn saved item ids + quantities into ONE URL that fills the Walmart cart in a single navigation — no clicking, no per-item pages. Quantities ADD to what is already in the cart, so pass the DELTA, not the target. Navigate to the returned URL in the signed-in browser, then confirm against /cart. There is no Amazon equivalent.', inputSchema: { type: 'object' as const, properties: { items: { type: 'array', description: 'Items to add.', items: { type: 'object', properties: { item_id: { type: 'string', description: 'Walmart item id from get_shopping_items.' }, qty: { type: 'integer', description: "How many to ADD. Defaults to the item's default_qty." } }, required: ['item_id'] } } }, required: ['items'] } },
    { name: 'save_shopping_item', description: 'Add or update an item in the saved catalogue, so the id never has to be looked up again. ONLY for something Jared has actually BOUGHT — never for an item that has merely been found or put in a cart. Walmart item ids are the trailing number of /ip/<slug>/<id>; Amazon ids are the ASIN.', inputSchema: { type: 'object' as const, properties: { retailer: { type: 'string', enum: ['walmart','amazon'] }, item_id: { type: 'string' }, name: { type: 'string' }, default_qty: { type: 'integer' }, category: { type: 'string' } }, required: ['retailer','item_id','name'] } },
    { name: 'get_walmart_cart', description: "What is in Jared's Walmart cart as of the last time it was read. Cheap — no browser. Read it BEFORE any cart work to know the starting point, since build_walmart_cart_url takes deltas. It is a recording, not live state: if a cart page was read more recently than this says, the recording is stale and record_walmart_cart fixes that.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'record_walmart_cart', description: 'Record what the Walmart cart ACTUALLY contains, from a /cart page just read in the browser. Replaces the stored cart wholesale — pass every line, not a delta. Call this after ANY cart change: the affiliate add-to-cart URL silently drops items while reporting success, so what was requested and what landed are different facts and only the observed one belongs here. Pass an empty items array for an empty cart.', inputSchema: { type: 'object' as const, properties: { items: { type: 'array', description: 'Every line in the cart, as read off the page.', items: { type: 'object', properties: { item_id: { type: 'string', description: 'Walmart item id.' }, name: { type: 'string', description: 'Name as the CART renders it.' }, qty: { type: 'integer' }, line_total: { type: 'number', description: 'Line total shown in the cart.' } }, required: ['item_id','name','qty'] } }, unit_count: { type: 'integer', description: "Walmart's own 'N items' count from the cart header." }, subtotal: { type: 'number' }, savings: { type: 'number' } }, required: ['items'] } },
    { name: 'get_weekly_volume', description: 'Weekly hypertrophy volume per muscle (trailing N days, default 7), as fractional sets (primary mover = 1.0, secondary = 0.5) summed across all logged sets. Shows all muscle regions grouped by legs/push/pull/core against the weekly set target for that muscle, so gaps (e.g. untrained hamstrings) are visible. Returns a pre-formatted report — pass it to the user exactly as-is.', inputSchema: { type: 'object' as const, properties: { days: { type: 'integer', description: 'Trailing window in days. Defaults to 7.' } } } },
    { name: 'update_set', description: "Correct a logged set by its set id (shown in get_workout) — its exercise, weight, reps, the time it happened, or its note. Everything except `id` is optional and ONLY the fields you pass are changed, so fixing the weight leaves the reps and the timestamp exactly as they were; pass at least one. Use this to change which MOVEMENT a set was ('that last set was incline press, not chest press') rather than deleting and re-logging, because re-logging restamps the time and destroys the rest gap. The movement is named by `exercise_id` from get_workout_catalog, never by a name. `occurred_at` moves the set to a different time or day. Returns the day's table — pass it to the user exactly as-is.", inputSchema: { type: 'object' as const, properties: { id: { type: 'integer', description: 'Set id from get_workout.' }, exercise_id: { type: 'integer', description: 'Optional. Change which movement this set was, by its numeric id from get_workout_catalog.' }, weight_lbs: { type: 'number', description: 'Optional. Total weight in lbs; bodyweight = 0.' }, reps: { type: 'integer', description: 'Optional.' }, occurred_at: { type: 'string', description: "Optional. Move the set to another time, as LOCAL wall-clock 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD' for a bare day, which lands at noon). This is the clock reading where he was, never UTC." }, note: { type: 'string', description: "Optional. Set or replace this set's free-text note (a grip, stance, tempo — 'that set was overhand grip'). An empty string removes it." } }, required: ['id'] } },
    { name: 'remove_set', description: 'Delete a logged set by its set id (shown in get_workout).', inputSchema: { type: 'object' as const, properties: { id: { type: 'integer', description: 'Set id from get_workout.' } }, required: ['id'] } },
    { name: 'list_recipes', description: "List every saved recipe with its per-serving macros and tags. Use it when the user explicitly names a RECIPE — 'my oatmeal recipe', 'log the gochujang tofu recipe' — to find what it is filed as. A meal described by a past log ('same as yesterday', 'what I had Monday', 'my usual oatmeal') is NOT a recipe request, even when its name matches one: that is get_nutrition for the day he pointed at. Optionally filter by tag.", inputSchema: { type: 'object' as const, properties: { tag: { type: 'string', description: "Optional tag filter (e.g. 'breakfast', 'high-protein')." } } } },
    { name: 'get_recipe', description: "Full detail of one saved recipe: every ingredient with its own portion, macros and produce classification, the steps, and the per-serving totals. The name matches case-insensitively and will also match on a distinctive part of it ('gochujang tofu' finds 'Gochujang Tofu Bowl'); a partial that matches several recipes returns the candidates instead of guessing. Use it to show the user a recipe or to check what is in one before changing it.", inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Recipe name, or a distinctive part of it.' } }, required: ['name'] } },
    { name: 'save_recipe', description: "Create or update a saved recipe — a meal the user makes often, stored once so it can afterwards be logged by name alone. Use it whenever they say to save/add something as a recipe. A recipe with the same name is OVERWRITTEN wholesale (a save states the recipe as it now is), so call get_recipe first when you are amending one rather than replacing it. ONE RECIPE IS ONE SERVING — record the amounts for a single serving and let the servings multiplier at log time do the rest. INGREDIENTS ARE THE SAME STRUCTURE log_nutrition TAKES, and for the same reason: logging a recipe expands into exactly these rows, so a recipe has to carry everything a logged meal carries. Each ingredient needs `food` (clean name, no amount baked in), `amount`, `unit`, and its OWN protein_g/carbs_g/fat_g (calories optional — label calories are trusted, otherwise derived from the macros). PRODUCE: every ingredient that is a fruit or vegetable must ALSO carry `produce_g` (its as-eaten weight in GRAMS, converted from the portion you recorded) and `produce_type` — the categories are defined on that field. For a mixed ingredient (salsa, a smoothie, a sauce), count only the produce share of its weight. Estimate any macro the user does not state, from standard nutrition knowledge and the amount recorded. Do NOT send recipe-level totals — the server derives calories/protein/carbs/fat by SUMMING the ingredients, always. `steps`, `tags` and `notes` are optional. To save a meal that is already in the log ('save that as a recipe', 'add what I just ate as my oatmeal recipe'), pass `from_entry` with the entry's id instead of re-describing it: its ingredients are copied verbatim.", inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Recipe name — the plain identity of the dish, no quantities in it. Omit ONLY with from_entry, where the entry\'s name is used.' }, from_entry: { type: 'string', description: "Nutrition entry ID or 8-char prefix (from get_nutrition or list_staged) to build the recipe from. Its ingredients become the recipe's; `ingredients` is then not needed. Call get_nutrition first if you only know the meal by name." }, ingredients: { type: 'array', description: 'One entry per component, each with structured food/amount/unit plus its own macros and (for produce) produce_g/produce_type. Required unless from_entry is given. A single-component recipe is one ingredient.', items: { type: 'object', properties: { food: { type: 'string', description: "Clean food name with no amount or unit, e.g. 'rolled oats', 'banana', 'firm tofu'." }, amount: { type: 'number', description: 'Numeric quantity these macros are for, e.g. 236, 1, 0.5.' }, unit: { type: 'string', description: "Measurement unit (g, cup, tbsp, tsp, ml, scoop, slice, oz, block, ...). Empty string or omit for bare counts like 1 banana." }, notes: { type: 'string', description: "Optional prep or sourcing note for this ingredient ('drained', 'the tub that says 24 g a scoop'). Recipe-only — it never travels into a logged meal." }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: 'As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set (and only then).' }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: PRODUCE_TYPE_DESC } }, required: ['food', 'amount', 'protein_g', 'carbs_g', 'fat_g'] } }, steps: { type: 'array', items: { type: 'string' }, description: 'Optional step-by-step instructions.' }, tags: { type: 'array', items: { type: 'string' }, description: "Optional tags for filtering (e.g. ['breakfast', 'high-protein'])." }, notes: { type: 'string', description: 'Optional recipe-level note.' } } } },
    { name: 'delete_recipe', description: 'Permanently delete a saved recipe by name (case-insensitive). Its ingredients and steps go with it; meals already logged from it are untouched.', inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Recipe name.' } }, required: ['name'] } },
    { name: 'log_recipe', description: "Log (or stage) a SAVED recipe by name — ONLY when the user explicitly says it is a recipe: 'log my overnight oats recipe', 'I had the gochujang tofu recipe', 'stage two servings of my chili recipe'. A meal that merely shares a recipe's name is not one, and a meal described by a past log ('same as yesterday', 'what I had Monday') is NEVER logged from a recipe — copy that logged entry with log_nutrition instead, because the recipe may not match what he actually ate. Everything the entry needs is already stored, so this takes only the recipe's name and how many servings; the server expands the recipe into its own ingredients, scales every amount, macro and produce weight by `servings`, and the entry lands identical to typing the meal out by hand. It is the ONLY way to log a saved recipe — log_nutrition is for food that is not one, and re-describing a saved recipe there would replace macros the user has already pinned down with fresh estimates. Call list_recipes if you are unsure what the named recipe is filed as; the name here matches case-insensitively and on a distinctive part of it, and an ambiguous partial is refused rather than guessed. If the recipe does not exist, log it with log_nutrition instead (and offer to save it).", inputSchema: { type: 'object' as const, properties: { recipe: { type: 'string', description: 'Saved recipe name, or a distinctive part of it.' }, servings: { type: 'number', description: 'Serving multiplier. Defaults to 1. Use it for "two servings", "half a batch".' }, stage: { type: 'boolean', description: "True to STAGE it rather than log it — the user said 'stage', 'might eat', or 'for later'. Staged meals do not count toward totals until committed. Defaults to false." }, occurred_at: { type: 'string', description: 'Optional. Only include if the user explicitly specifies a date or time; otherwise omit.' } }, required: ['recipe'] } },
    { name: 'log_nutrition', description: "Log food ALREADY EATEN — it counts toward today's totals. Use this ONLY when the user says they ate/had it or says 'log'. If they say 'stage', 'staging', 'stage it', 'might eat', or 'for later', you MUST call stage_meal instead and NOT log it — honor the user's verb exactly; 'stage' is never a log. If they REFERENCE a food they ate before ('the same oatmeal as yesterday', 'the tofu dish I had Monday', 'the same as last week', 'my usual oatmeal'), you MUST first call get_nutrition for that day (for 'my usual', the most recent day it appears), find the matching entry, and reuse its exact name, ingredients and macros, applying only the changes they state — never ask them to re-describe something already logged, and NEVER substitute a saved recipe for it, even one with the same name. Use log_recipe ONLY when they explicitly say it is a recipe ('my oatmeal recipe'). If they name a food, record it as a structured ingredient carrying food + amount + unit and ESTIMATE its macros from standard nutrition knowledge (a scoop of protein powder ≈ 25 g protein, ~120 cal; one medium banana ≈ 105 cal). The amount/unit (the portion) is normally YOURS to choose from whatever quantity cue the user gives: an explicit measure ('a cup', '6 oz', 'a scoop') use it; a vague quantifier ('some', 'a bit', 'a handful', 'a small/large serving', 'a bowl') pick a reasonable concrete amount and unit; a count or naturally-single item ('a banana', 'two eggs', a bare countable food = one) use that count (the unit may be empty for bare counts). As long as there is ANY indication of quantity, NEVER ask — just pick a sensible amount and unit. Ask the user to clarify ONLY when EITHER (a) the FOOD ITSELF is unintelligible (audio cut off or garbled), OR (b) there is NO quantity indication at all on a food that needs one (e.g. 'add rice' with no amount and no natural single-unit default — a bulk food with zero quantity cue usually means the request got cut off). Keep the food NAME a PLAIN identity with NO quantity of any kind in it (no amounts, portions, counts, units, ingredient lists, or '(N×)' multiplier; e.g. 'Red wine', not 'Red wine (100 g)') — all quantity lives in the ingredient's amount and unit. Ingredient calories are optional (label calories trusted; else derived from the macros). The server stores every food as INGREDIENTS and computes the entry's calories/protein/carbs/fat by SUMMING them, so you never send a separate top-level total. For composite meals (e.g. an omelet, a stir-fry, overnight oats), include `ingredients`: an array with one entry per component, each with its OWN protein_g/carbs_g/fat_g (and calories when known). For each ingredient provide STRUCTURED fields — `food` (clean food name with NO amount or unit baked in, e.g. 'rolled oats', 'banana', 'protein powder'), `amount` (the numeric quantity these macros are for, e.g. 1, 0.5, 0.75), and `unit` (the measurement unit like 'cup', 'tbsp', 'g', 'scoop', 'slice', 'oz'; use an empty string or omit it for bare counts like 1 banana) — plus the macros (calories optional, protein_g/carbs_g/fat_g) for that amount. Keeping food/amount/unit separate lets the amounts be adjusted later. You may omit `name`; the server synthesizes a display name from food/amount/unit. The server derives the entry totals by summing the ingredients, so do NOT send a top-level total for a composite meal. For a single-component food, send it as ONE structured ingredient (food + amount + unit + macros); do not use the bare top-level `nutrition` field. Keep each component's calories roughly consistent with its protein/carbs/fat (≈4/4/9, allowing for fiber and alcohol) — the server soft-warns when they're wildly off, which usually signals a bad macro estimate. PRODUCE: every ingredient that is a fruit or vegetable must ALSO carry `produce_g` (its as-eaten weight in GRAMS, converted from the portion you recorded) and `produce_type` — the categories are defined on that field. For a mixed ingredient (salsa, a smoothie, a sauce), count only the produce share of its weight. For recipe entries, provide a recipe name and optional servings. `occurred_at` is optional. Only include it if the user explicitly specifies a date or time; otherwise omit it. Always confirm what was logged by passing the result to the user as-is.", inputSchema: { type: 'object' as const, properties: { items: { type: 'array', description: 'List of food items eaten.', items: { oneOf: [ { type: 'object', properties: { name: { type: 'string', description: 'Plain food/dish name ONLY — the identity of the food, never any quantity. No amounts, portions, counts, units, ingredient lists, or "(N×)" multiplier anywhere in the name. Good: "Red wine", "Overnight oats", "Omelet", "Caffè latte", "Banana", "Protein powder". Bad: "Red wine (100 g)", "Banana (1/3)", "Protein powder (1 scoop)", "Three-egg omelet". All quantity lives in the macros and structured ingredients (which the UI scales); the name must stay valid no matter how the portion is later changed.' }, nutrition: { type: 'object', description: 'Macros for a SINGLE-component food (the server stores it as one ingredient and the entry totals equal these). For a composite meal, use `ingredients` instead. protein_g, carbs_g, and fat_g required; calories optional (label calories trusted, else derived).', properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } }, required: ['protein_g', 'carbs_g', 'fat_g'] }, ingredients: { type: 'array', description: 'Per-ingredient breakdown for composite meals (omelet, stir-fry, overnight oats). One entry per component, each with structured food/amount/unit so amounts can be adjusted later; the macros (and optional calories) are for that amount. The server SUMS the ingredients to get the entry totals. Use this for every food, including a single-component food (one ingredient with food/amount/unit).', items: { type: 'object', properties: { food: { type: 'string', description: "Clean food name with no amount or unit, e.g. 'rolled oats', 'banana', 'protein powder'." }, amount: { type: 'number', description: 'Numeric quantity these macros are for, e.g. 1, 0.5, 0.75.' }, unit: { type: 'string', description: "Measurement unit (cup, tbsp, tsp, g, ml, scoop, slice, oz, ...). Empty string or omit for bare counts like 1 banana." }, name: { type: 'string', description: 'Optional display name; omit when food/amount/unit are given and the server will synthesize it.' }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: "As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set (and only then). Convert from the portion unit: 1 cup raw leafy greens ≈ 30 g, 1 cup chopped broccoli ≈ 90 g, 1 medium apple ≈ 180 g, 1 medium banana ≈ 118 g, half an avocado ≈ 70 g. For a mixed ingredient (salsa, a sauce), count only the produce share of its weight." }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: PRODUCE_TYPE_DESC } } } }, occurred_at: { type: 'string', description: 'Optional. Only include if the user explicitly specifies a date or time; otherwise omit.' } }, required: ['name'] } ] } } }, required: ['items'] } },
    { name: 'get_nutrition', description: 'Get the nutrition log for a given date, including a daily totals summary.', inputSchema: { type: 'object' as const, properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' } } } },
    { name: 'delete_nutrition_entry', description: 'Remove a specific entry from the nutrition log by its ID.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Entry ID or 8-char prefix.' } }, required: ['id'] } },
    { name: 'subtract_leftovers', description: "Scale an ALREADY-LOGGED dish down by the weight the user did NOT eat. Use this whenever they give a leftover WEIGHT — 'I left 92 grams of that bowl', 'there was about 100 g left over', 'subtract 80 g from the stir-fry'. Every ingredient shrinks by the same fraction, because leftovers are a sample of the whole dish and not of one part of it, and the entry's calories/macros/produce are re-derived from the scaled ingredients. Identify the dish by ID or 8-char prefix — call get_nutrition first if you only know it by name. The dish's total cooked weight is worked out from the ingredients whose portions are already in grams, plus any produce (which carries its own gram weight). If an ingredient is portioned in a unit with no fixed gram weight — tofu by the block, rice by the cup, a scoop of something — the call FAILS and names them; estimate the whole dish's cooked weight yourself from standard food weights (a 14 oz block of tofu ≈ 396 g, 1 cup cooked rice ≈ 158 g, 1 cup cooked pasta ≈ 140 g) and pass it as total_g. Do NOT use this when the user gives a fraction or portion instead of a weight ('I only ate half') — that is a plain edit of the amounts, not a leftover subtraction.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Entry ID or 8-char prefix of the logged dish.' }, grams: { type: 'number', description: 'Weight in GRAMS left uneaten. Must be less than the dish total.' }, total_g: { type: 'number', description: "Optional. The dish's total cooked weight in grams. Needed only when an ingredient's portion cannot be weighed from its unit (block, cup, scoop, slice) — the error message names them when that happens." } }, required: ['id', 'grams'] } },
    { name: 'stage_meal', description: "Stage a meal the user MIGHT eat or will eat later, WITHOUT logging it as eaten — staged items do NOT count toward totals until committed. Whenever the user says 'stage', 'staging', 'stage it', 'might eat', or 'for later', use THIS tool — NEVER log_nutrition — even when they give full details; honor their verb exactly. If they REFERENCE a food they ate before ('stage the tofu dish I had yesterday', 'the same as last week', 'my usual oatmeal'), you MUST first call get_nutrition for that day (for 'my usual', the most recent day it appears), find the matching entry, and reuse its exact name, ingredients and macros, applying only the changes they state — never ask them to re-describe something already logged, and NEVER substitute a saved recipe for it, even one with the same name. Use log_recipe (with stage) ONLY when they explicitly say it is a recipe ('stage my chili recipe'). If they name a food, record it as a structured ingredient carrying food + amount + unit and ESTIMATE its macros from standard nutrition knowledge. The amount/unit (the portion) is normally YOURS to choose from any quantity cue the user gives (an explicit measure; a vague quantifier like 'some'/'a bit'/'a handful'/'a small serving'; or a count / naturally-single item like 'a banana' = one). As long as there is ANY indication of quantity, NEVER ask — pick a sensible amount and unit. Ask ONLY when (a) the FOOD ITSELF is unintelligible, or (b) there is NO quantity indication at all on a food that needs one (e.g. 'add rice'). Same shape as log_nutrition: always structured `ingredients`, each carrying `food` + `amount` + `unit` and its own macros (calories optional, label calories trusted). The server stores every food as ingredients and sums them for the entry totals. PRODUCE: every ingredient that is a fruit or vegetable must ALSO carry `produce_g` (its as-eaten weight in GRAMS, converted from the portion you recorded) and `produce_type` — the categories are defined on that field. For a mixed ingredient (salsa, a smoothie, a sauce), count only the produce share of its weight. Staged meals are NOT counted in any totals until committed, they always surface in the current day's list, and they persist until committed or removed (no auto-expiry). Confirm by passing the result back to the user.", inputSchema: { type: 'object' as const, properties: { items: { type: 'array', description: 'Meals to stage.', items: { type: 'object', properties: { name: { type: 'string', description: 'Plain food/dish name ONLY — the food identity, never any quantity (no amounts, portions, counts, units, ingredient lists, or "(N×)" multiplier). Good: "Red wine", "Overnight oats". Bad: "Red wine (100 g)", "Three-egg omelet". Quantity lives in the macros/ingredients, which the UI scales.' }, nutrition: { type: 'object', properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } }, required: ['protein_g', 'carbs_g', 'fat_g'] }, ingredients: { type: 'array', description: 'Optional per-ingredient breakdown (same structured food/amount/unit + macros as log_nutrition).', items: { type: 'object', properties: { food: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string' }, name: { type: 'string' }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: 'As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set.' }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: PRODUCE_TYPE_DESC } } } } } } } }, required: ['items'] } },
    { name: 'list_staged', description: 'List all staged (not-yet-eaten) meals with their IDs and macros.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'commit_staged', description: 'Commit a staged meal — log it as eaten right now so it counts toward today. Identify it by its ID or 8-char prefix.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Staged meal ID or 8-char prefix.' } }, required: ['id'] } },
    { name: 'edit_staged', description: "Edit a staged meal's name and/or ingredients; the server re-derives the entry totals from the ingredients. For a simple food you may pass `nutrition` (macros) and it's folded into the single ingredient. Identify it by ID or 8-char prefix.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Staged meal ID or 8-char prefix.' }, name: { type: 'string' }, nutrition: { type: 'object', properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } } }, ingredients: { type: 'array', items: { type: 'object', properties: { food: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string' }, name: { type: 'string' }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: 'As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set.' }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: PRODUCE_TYPE_DESC } } } } }, required: ['id'] } },
    { name: 'edit_nutrition_entry', description: "Change a meal that is ALREADY LOGGED, in place — add or remove an ingredient, fix an amount, rename it, or move it to the time he actually ate it ('add 28 g of peanut butter to the cereal', 'that was two eggs not three', 'I ate that at noon'). Use this rather than deleting and re-logging, which loses the entry's identity. To change the food, pass the COMPLETE new `ingredients` list: call get_nutrition first, take the entry's current ingredients, apply only what he changed, and send the whole list back — what you send replaces what is there, and the server re-derives the totals from it. Omit `ingredients` to leave the food alone. Identify the entry by ID or 8-char prefix from get_nutrition.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Entry ID or 8-char prefix.' }, name: { type: 'string', description: 'New plain dish name, no quantities. Omit to keep it.' }, occurred_at: { type: 'string', description: "When he actually ate it, LOCAL wall clock 'YYYY-MM-DDTHH:MM'. Only when he says the time was wrong; omit otherwise." }, nutrition: { type: 'object', properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } } }, ingredients: { type: 'array', items: { type: 'object', properties: { food: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string' }, name: { type: 'string' }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: 'As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set.' }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: PRODUCE_TYPE_DESC } } } } }, required: ['id'] } },
    { name: 'remove_staged', description: 'Remove/delete a staged meal by ID or 8-char prefix. Does not affect committed entries.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Staged meal ID or 8-char prefix.' } }, required: ['id'] } },
    { name: 'reload_wall', description: 'Reload the TV wall display (the Pi kiosk browser). Use when the wall is frozen, blank, stale, or showing a crashed/"Aw Snap" page. Kills the kiosk chromium; the Pi automatically relaunches it fresh within a few seconds.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'get_due', description: "Everything with a due date, across all lists, soonest first — this is what his reminders are, since a reminder is just a dated item. Defaults to overdue plus the next couple of days, which is what makes a request like 'check off the teeth brushing' resolvable: a repeating thing is stored as one item per day, so a wide window returns many rows that differ only by date. Widen with `days` only when he asks about further ahead.", inputSchema: { type: 'object' as const, properties: { days: { type: 'number', description: 'How many days ahead to include. Default 2. Overdue items are always included whatever this is.' } } } },
    { name: 'get_lists', description: "Show Jared's lists. Omit `list` to see every list with its items; pass `list` to see just that one. Use when he asks what is on a list, and to read his notes — they are items on the `notes` list, whose full body is printed under each one.", inputSchema: { type: 'object' as const, properties: { list_id: listIdProp(roster, 'Optional — show only this list. Omit to show all of them.') } } },
    { name: 'add_to_list', description: "Add an item to a list, which covers reminders AND notes too — a reminder is only an item with a `due` date, and anything dated fires a notification whichever list it is on; a note is only an item with a body, so 'make a note', 'jot this down', 'save this' is an undated item on the `notes` list with the short name as `title` and the full body as `text`. Omit `list` for the default todo list; an unknown list is created, so reuse an existing name when the intent is the same list.", inputSchema: { type: 'object' as const, properties: { list_id: listIdProp(roster, `Which list to add to. Omit for the default '${lists.DEFAULT_LIST_ID}' list. It must ALREADY EXIST — this tool never creates one; use create_list for that.`), text: { type: 'string', description: 'The item itself, e.g. "milk" or "call the dentist". Do NOT bake date words into this — put times in `due`.' }, title: { type: 'string', description: "SHORT label — this is what every display actually shows. Two or three words, and prefer fewer: on the wall's day timeline several items share one line side by side, so a long title squeezes its neighbours and gets truncated. 'Shirt in dryer', not 'Put the white shirt in the dryer'. Set it whenever `text` runs longer than that, and keep the full detail in `text`." }, due: { type: 'string', description: 'Optional due date/time, ISO 8601 local (YYYY-MM-DD or YYYY-MM-DDTHH:MM). Setting it makes the item fire a notification then. Omit if no time was given.' }, priority: { type: 'number', description: "How it scores. OMIT THIS FIELD ENTIRELY unless he says one of the words below — leaving it out makes the item inherit its list's default, which is how lists like 'work' stay exempt without him repeating himself. Do not send 0 to mean 'nothing special'; 0 is an explicit override that would cancel the list's default. Never infer this from what the item is: a shift, an appointment, a flight and a chore are all left alone unless he says otherwise, because a wrong guess changes his score and nothing tells him a guess was made. Send 1 only when he says important, urgent, high priority, or a priority. Send -1 only when he says exempt, excluded, don't score it, don't count it, or don't hold me to it. Send 0 only when he explicitly says something is a normal task ON a list whose default is not normal." }, repeat_every: { type: 'string', description: "Optional recurrence, as '<n> <unit>' — e.g. '1 day', '2 hours', '30 minutes', '1 week', '1 month', '1 year'. Use for 'every morning', 'every Monday', 'twice a day' (that is '12 hours'). Requires `due`, which sets the FIRST occurrence. This SCHEDULES EVERY OCCURRENCE AS ITS OWN ITEM in one call — checking one off leaves the rest alone — so it is cheap to use and never needs calling repeatedly. Omit for a one-shot, which is the default." }, repeat_until: { type: 'string', description: "Last date the recurrence runs to (YYYY-MM-DD). Use whatever end he gave — 'for the next two weeks', 'until the 30th'. Defaults to a month out when he gave no end; there is no such thing as forever here, and it can be extended later." }, alarm: { type: 'boolean', description: "True makes this RING rather than notify: the TV and any open hub app play an alarm on a loop from its moment until he stops it. Requires `due`. SEND IT ONLY WHEN HE SAID SO — 'set an alarm', 'wake me', 'a timer for', 'make sure it wakes me'. Never infer it from what the item is or from how urgent it sounds: this one wakes a room, and nothing on any surface tells him a guess was made. A plain dated item already notifies, which is the right answer for almost everything." } }, required: ['text'] } },
    { name: 'set_due', description: "Move an existing item to a different time, or clear its due date — 'push the dentist one to Friday', 'snooze that', 'make it 3 instead'. ONLY when the task itself is unchanged and just needs to happen later. If he names a DIFFERENT thing to do, that is a new item (add_to_list), not a move — 'take the shirt off and put it back up at 1 to go in the dryer' is completing one item and adding another, not rescheduling one. Identify the item by id from get_due or get_lists.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Item id or its leading characters.' }, list_id: listIdProp(roster, 'Optional — narrow the id search to one list. Omit to search every list.'), due: { type: 'string', description: 'New due date/time, ISO 8601 local (YYYY-MM-DD or YYYY-MM-DDTHH:MM). Pass empty to REMOVE the due date, which stops it firing and takes it off his score. Omit entirely to leave the date alone.' } }, required: ['id'] } },
    { name: 'set_priority', description: "Change how an existing item scores, when he says to — 'make that one important', 'that one's urgent', 'make that exempt', 'don't score that one', 'it's not a priority any more'. Important items count for more on his score in both directions. Identify the item by id from get_due or get_lists.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Item id or its leading characters.' }, list_id: listIdProp(roster, 'Optional — narrow the id search to one list. Omit to search every list.'), priority: { type: 'number', description: "1 important, 0 normal, -1 exempt. Set only what he actually asked for — 'make it important' is 1, 'make it exempt' or 'stop scoring that' is -1, 'back to normal' is 0. Do not infer it from what the item is." } }, required: ['id', 'priority'] } },
    { name: 'complete_item', description: "Mark something DONE — he did it. 'I cleaned the shirt', 'check that off', 'completed', 'finished', 'took care of it', 'done with that one', 'took the trash out'. This is what he means almost every time something leaves his list, so reach for it first. It earns him points on his score, more the sooner it is done, and the item stays on his calendar as something that happened rather than disappearing. Use remove_from_list ONLY when he wants a thing gone that he did NOT do. Identify by id from get_due or get_lists. When he says WHEN he finished — 'at 10:15', 'fifteen minutes after it started', 'an hour ago', 'this morning' — pass `at`; the completion time is what decides the points, so a completion he is reporting after the fact scores wrongly without it.", inputSchema: { type: 'object' as const, properties: { list_id: listIdProp(roster, 'Optional — the list the item is on. Omit to search every list.'), id: { type: 'string', description: 'Item id or its leading characters (from get_lists or get_due).' }, at: { type: 'string', description: "When he finished it, if that is not right now: local wall clock 'YYYY-MM-DDTHH:MM', the same form as the due date get_due shows. Omit for the ordinary case — leaving it out stamps the moment he spoke, which is what 'done' means unqualified. Work the time out yourself and pass the exact value: get_due gives you the item's own due time, so 'fifteen minutes after it started' on something due 10:00 is 10:15, and 'an hour ago' is the current time minus an hour. No timezone, no Z, no offset — a bare local reading, or the score is measured against the wrong deadline. It cannot be in the future." }, undo: { type: 'boolean', description: 'True to un-complete something marked done by mistake — "no, I haven\'t done that yet". Puts it back on the list and takes the points back.' } }, required: ['id'] } },
    { name: 'remove_from_list', description: "DELETE an item he is not going to do — 'get rid of that', 'delete it', 'take that off, I'm not doing it', 'never mind that one'. It is gone: no points, and no record that it ever happened. If he DID the thing, use complete_item instead; that is the far more common case, and deleting a finished task loses him the credit for it. Identify by id from get_lists or get_due. To drop a whole repeating thing rather than one occurrence, pass `series` — 'stop the teeth brushing', 'cancel the whole daily thing'.", inputSchema: { type: 'object' as const, properties: { list_id: listIdProp(roster, 'Optional — the list the item is on. Omit to search every list.'), id: { type: 'string', description: 'Item id or its leading characters (from get_lists or get_due).' }, series: { type: 'boolean', description: 'True to delete every remaining occurrence of the series this item belongs to, not just this one. Only when he means the whole recurring thing.' } }, required: ['id'] } },
    { name: 'set_list_priority', description: "Set what NEW items on a list score as by default, so he does not have to say it every time — 'everything on my work list is exempt', 'default the work list to exempt', 'make my todo list normal again'. Items already on the list keep whatever they have; this only changes what gets added from now on. An individual item can still override it when he says so.", inputSchema: { type: 'object' as const, properties: { list_id: listIdProp(roster, 'The list to change.'), priority: { type: 'number', description: '1 important, 0 normal, -1 exempt.' } }, required: ['list_id', 'priority'] } },
    { name: 'set_list_emoji', description: "Give a list an emoji, which leads the notification when a dated item on it comes due; empty removes it.", inputSchema: { type: 'object' as const, properties: { list_id: listIdProp(roster, 'The list to change.'), emoji: { type: 'string', description: 'A single emoji, e.g. "🛒". Empty removes it.' } }, required: ['list_id'] } },
    { name: 'list_repos', description: "Jared's projects, most recently worked on first. Call this when he names a project you are not sure of before using start_session — matching against the real list beats guessing at a name.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'start_session', description: "Start a Claude session on one of Jared's machines to do the work he just described. This is also how anything that needs his SIGNED-IN browser gets done: a session has a real browser logged in to his accounts, so acting on a site (his Amazon or Walmart cart, an order, a ride, a booking, a form) or reading something behind his logins (an order's status, what is in a cart) is a session — start one and pass the request through. A plain lookup is not: if you have web search, answer it yourself. Pass his words through verbatim, minus the addressing ('in my X repo', 'send this to the Mac') — never summarise them.", inputSchema: { type: 'object' as const, properties: { repo: { type: 'string', description: "The project, if he named one. Omit when he did not or it is unclear — it then opens in his home directory, which is the right fallback rather than asking." }, prompt: { type: 'string', description: "What to do, word for word as he said it — rambling and self-corrections included, addressing stripped. Never summarise or tidy it; the session can read past disfluency, and rewriting loses what he actually said." }, label: { type: 'string', description: "A short name for the work — three to six words naming the JOB, not the repo: 'Add bagels to Walmart cart', never 'root' or 'status-hub'. Name the thing it will act on, because that is what he scans the list for: the product, the cart, the site, the file. REQUIRED, because nothing else ever names a dispatched session — a session he opened in a terminal himself gets its name from Claude Code, but a dispatch has only this, and omitting it leaves a row reading '(unnamed)' for the rest of its life." }, report: { type: 'boolean', description: "True only when he asks for a written write-up ('send me a report', 'write it up'). Otherwise omit." }, machine: { type: 'string', enum: ['pi', 'mac'], description: "Where to run it. Defaults to 'pi', which is almost always right; 'mac' only when he says so or for iOS work." } }, required: ['prompt', 'label'] } },
    { name: 'follow_up', description: "Send his words into a session, verbatim. Use it when he hands them over — 'tell it to', 'send a follow-up', 'let it know' — when this same utterance focused that session, and when what he says is plainly his answer to a session whose reply was just posted into this conversation: answering its question, approving or correcting its plan, telling it to go on. Pass that session as `session`. When he NAMES the session ('send a follow-up to the Walmart cart session'), pass it as `session`: the words go there whether it is running, busy mid-turn, or parked, and the pin is left alone. With no session named, they go to the pinned one (or, unpinned, the most recently active).", inputSchema: { type: 'object' as const, properties: { prompt: { type: 'string', description: 'His words, verbatim.' }, session: { type: 'string', description: "The session he named, if he named one. The ID from get_sessions (`s-a5181dfd`) names the conversation and never changes — look it up and pass it. Omit when he named none." } }, required: ['prompt'] } },
    { name: 'get_sessions', description: "The sessions running or parked on his machines, numbered as he refers to them, with each one's ID and what it last said. The number is a POSITION in this listing and moves whenever a session is resumed or ended; the id does not. Take the id from here for anything that acts on more than one session.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'bedroom_tv', description: "Control the BEDROOM TV, a TCL Google TV in his bedroom. NOT the wall (the TV that set_wall and reload_wall drive). One `op` per call; every setter answers with the value the TV reports afterwards — say that number, not the one asked for. Ops: `power` (`on` true to turn it on, false to turn it off), `brightness` (the screen's backlight 0-100; `value` omitted reads it), `contrast` (0-100), `night` (the dim picture he chose for watching in bed: brightness 0, contrast 60, dynamic contrast off), `volume` (0-100, omitted reads it), `open` (a URL with `app` to open it in that app — a YouTube video found with the `youtube` tool, never an invented id — or an `open:` deep link from the `catalog` tool, passed as is with no `app`, which opens that show or movie in Netflix, Prime Video, Apple TV and the rest), `launch` (an app by name), `sidebar` (the session he is working in, see-through down the right of the screen: `on` true/false), `overlay` (`text` in the top-right corner for `seconds`), `now` (the app and title playing, and how far in). It is his BEDROOM: when he is going to sleep or asleep, change nothing he did not ask for. `open` and `launch` turn the TV on first if it is off, so never turn it on separately before them. Any other op on a TV that is off answers that it is off. It cannot switch HDMI inputs or take a screenshot; for those, and for working out who or what is on screen (which takes several screenshots over time, captions and looking the episode up, never recognising faces), start a session — sessions have the `tv` skill. For falling asleep he wants long, light, mostly-talking videos (a panel show like QI), not visual documentaries, at the volume already set.", inputSchema: { type: 'object' as const, properties: { op: { type: 'string', enum: [...bedroomTv.OPS] }, value: { type: 'number', description: 'brightness / contrast / volume: the level to set. Omit to read it.' }, url: { type: 'string', description: 'open: the URL.' }, app: { type: 'string', enum: Object.keys(bedroomTv.APPS), description: 'launch: the app. open: the app to open the URL in (youtube for a YouTube link).' }, on: { type: 'boolean', description: 'power: true for on, false for off. sidebar: true to show it, false to hide it.' }, text: { type: 'string', description: 'overlay: the line to show.' }, seconds: { type: 'number', description: 'overlay: how long, default 5.' } }, required: ['op'] } },
    { name: 'youtube', description: "YouTube, public AND Jared's own account — the way to choose what to put on the bedroom TV and to recommend videos to him from what he actually watches. Public ops: `search` (real video ids with title, channel, length, views, age, in YouTube's order), `video` (title, channel, length, views, date, chapters and the FULL description — read it before choosing a video for its content, since a title often oversells it), `related` (what YouTube suggests after a video), `channel` (a channel's newest uploads, by @handle or channel id). His account, read through the Pi's browser signed in as him: `history` (what he watched, newest first, under day headings, with how much of each he watched), `home` (his personal YouTube recommendations), `subscriptions` (every channel he subscribes to), `subscription_feed` (new uploads from those channels), `watch_later`, `liked`, `playlists` (his playlists, with ids), `playlist` (one playlist's videos by id, his private ones too). Shorts are left out unless `shorts` is true. WebFetch cannot read any of this. No transcripts.", inputSchema: { type: 'object' as const, properties: { op: { type: 'string', enum: ['search', 'video', 'related', 'channel', ...youtubeAccount.OPS] }, query: { type: 'string', description: 'search: what to search for.' }, id: { type: 'string', description: 'video / related: the video id or URL. channel: an @handle or channel id. playlist: the playlist id.' }, limit: { type: 'number', description: 'How many items. Public ops default 10-15, at most 50; account ops default 50, at most 1000 (history goes back as far as YouTube keeps it).' }, shorts: { type: 'boolean', description: 'Account ops: include Shorts. Default false.' } }, required: ['op'] } },
    { name: 'catalog', description: "What is streaming where, across Netflix, Prime Video, Apple TV+, Disney+, Hulu, Max and the rest (JustWatch's catalog): the way to find a show or movie for him, recommend from the services he has, and put it on the bedroom TV. Ops: `search` (titles matching `query`, each with IMDb score, runtime, genres and which services carry it), `title` (one title by its id: description, cast, seasons with ids, and every service offering it, each with an `open:` deep link), `episodes` (a season by its id: every episode with its description and deep links), `popular` (popular / trending / newest / random titles, filtered by `services`, `type`, `genres`, release years and minimum IMDb score), `added` (titles newly added to `services` over the last `days`). `services` defaults to the ones he has (marked \"his\"); when those are not set yet, say so rather than assuming. To play something on the bedroom TV, pass an `open:` link to bedroom_tv `open` as `url`, as is: it opens that title in the service's app. Netflix and Disney+ are not signed in on the bedroom TV's own apps, so their links stop at a sign-in screen there.", inputSchema: { type: 'object' as const, properties: { op: { type: 'string', enum: ['search', 'title', 'episodes', 'popular', 'added'] }, query: { type: 'string', description: 'search: what to look for.' }, id: { type: 'string', description: 'title: a title id (ts… show, tm… movie). episodes: a season id (tss…).' }, type: { type: 'string', enum: ['movie', 'show'], description: 'Restrict to movies or shows.' }, services: { type: 'array', items: { type: 'string', enum: Object.keys(catalog.SERVICES) }, description: 'popular / added: which services. Omit for his.' }, genres: { type: 'array', items: { type: 'string', enum: Object.values(catalog.GENRES) } }, sort: { type: 'string', enum: ['popular', 'trending', 'newest', 'random'], description: 'popular: the order. Default popular.' }, year_min: { type: 'number' }, year_max: { type: 'number' }, imdb_min: { type: 'number', description: 'popular: lowest IMDb score, e.g. 7.5.' }, days: { type: 'number', description: 'added: how many days back, default 7, at most 30.' }, limit: { type: 'number' } }, required: ['op'] } },
    { name: 'set_wall', description: "Switch the TV between the home wall (the default), the health wall, the sessions wall and the calendar wall. When he sizes the calendar in the same breath ('show the full year', 'four months'), pass months too.", inputSchema: { type: 'object' as const, properties: { mode: { type: 'string', enum: ['standard', 'home', 'health', 'sessions', 'calendar'], description: 'Which wall to show. `home` and `standard` are the same wall — the default: today as a dial, the heat maps, the newest session. `health` is nutrition, the muscle map and the workout heatmap with their detail panels.' }, months: { type: 'number', description: 'Calendar wall only: how many months it spreads across, 1-12 (a year is 12). Omit to leave the current spread alone.' } }, required: ['mode'] } },
    { name: 'focus_session', description: "Pin a running session so follow-ups go to it even after another session becomes more recent. 'Focus X' and 'pin X' are the same request, as are 'focus something else' and 'pin something else'. 'Focus (or pin) the latest session' is a pin too: pin whichever is number 1 in get_sessions right now. To go back to following whichever is most recent, use unfocus_session instead. If this same utterance goes on to say what to do, send that part with follow_up. It does not carry past this utterance.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session. The ID (`s-a5181dfd`, shown beside every row in get_sessions) names the conversation itself and never changes, through every resume and every move between machines — it is the only handle that cannot go stale, and the one to save anywhere he may come back to — USE IT for anything touching more than one session, because the NUMBER is a position in that listing and every resume or end renumbers what is left. A number ('3') or words from the name are fine for a single session he just named out loud." } }, required: ['session'] } },
    { name: 'unfocus_session', description: "Release a pinned session so follow-ups go to whichever session is most recently active again — 'unfocus', 'remove the focus', 'unpin it', 'take the pin off', 'go back to automatic'. Not for pinning the newest session: that is focus_session with its number.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'rename_session', description: "Name a session. The name is set on the session itself, not only in this list.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session. The ID (`s-a5181dfd`, shown beside every row in get_sessions) names the conversation itself and never changes, through every resume and every move between machines — it is the only handle that cannot go stale, and the one to save anywhere he may come back to — USE IT for anything touching more than one session, because the NUMBER is a position in that listing and every resume or end renumbers what is left. A number ('3') or words from the name are fine for a single session he just named out loud." }, name: { type: 'string', description: 'The name, in his words. A few words, no punctuation needed.' } }, required: ['session', 'name'] } },
    { name: 'transfer_session', description: "Move a session to the other machine with its whole conversation, closing it where it is. Works even when the machine holding it is asleep.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session. The ID (`s-a5181dfd`, shown beside every row in get_sessions) names the conversation itself and never changes, through every resume and every move between machines — it is the only handle that cannot go stale, and the one to save anywhere he may come back to — USE IT for anything touching more than one session, because the NUMBER is a position in that listing and every resume or end renumbers what is left. A number ('3') or words from the name are fine for a single session he just named out loud. Call get_sessions first if you are not sure which he means — an ambiguous name is answered with the choices, not a guess." }, machine: { type: 'string', enum: ['pi', 'mac'], description: 'Where it should end up.' } }, required: ['session', 'machine'] } },
    { name: 'resume_session', description: "Bring a parked session back with its full context.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session. The ID (`s-a5181dfd`, shown beside every row in get_sessions) names the conversation itself and never changes, through every resume and every move between machines — it is the only handle that cannot go stale, and the one to save anywhere he may come back to — USE IT for anything touching more than one session, because the NUMBER is a position in that listing and every resume or end renumbers what is left. A number ('3') or words from the name are fine for a single session he just named out loud." }, prompt: { type: 'string', description: 'Optional follow-up to send once it is back.' } }, required: ['session'] } },
    { name: 'end_session', description: 'Close a running session for good. Use when he says he is done with one.', inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session. The ID (`s-a5181dfd`, shown beside every row in get_sessions) names the conversation itself and never changes, through every resume and every move between machines — it is the only handle that cannot go stale, and the one to save anywhere he may come back to — USE IT for anything touching more than one session, because the NUMBER is a position in that listing and every resume or end renumbers what is left. A number ('3') or words from the name are fine for a single session he just named out loud." } }, required: ['session'] } },
    { name: 'publish_report', description: "Publish an HTML write-up of work just finished, as well as replying normally — Jared reads it on his phone. Send a body fragment with RAW tags (no <html>/<head>/<body>, and never escaped entities, which render as visible source). Design for a 390px portrait column: short paragraphs, 2-3 column tables, every <svg> given a viewBox and width=\"100%\" rather than fixed pixels. A Content-Security-Policy blocks all JavaScript and external stylesheets, so charts must be inline <svg>; inline <style> and data:/https: images do work.", inputSchema: { type: 'object' as const, properties: { title: { type: 'string', description: "Short page title, e.g. \"Widget freshness fix\". Shown as the notification title." }, summary: { type: 'string', description: "One sentence saying what you did. This becomes the notification body, so it must stand alone on a lock screen." }, html: { type: 'string', description: "The report body as HTML. Inline SVG for visuals; no scripts." } }, required: ['title', 'summary', 'html'] } },
    { name: 'set_surf_alarm', description: "Wake him depending on the SURF at Mayport Poles: an alarm whose time is decided by the forecast, and re-decided by the hub every time a new forecast lands overnight, with nobody awake. Use when he makes a wake time depend on conditions — 'if it's fair at 7 and 8 wake me at 6, if it's fair at 8 and 9 wake me at 7'. Rules are ORDERED and the first match wins. A rule matches when EVERY hour in `hours` is Fair or better that morning AND no hour in `not_fair` is; hours in neither list do not matter. 'Fair at 8 and 9 but nothing after' is hours [8, 9] with not_fair [10, 11, ...]. No match means no alarm, unless he gave an 'otherwise' time, which is a last rule with both lists empty. Pass his conditions as he said them — never reuse a previous night's. `engaged: false` turns it off.", inputSchema: { type: 'object' as const, properties: { day: { type: 'string', description: 'The morning it wakes him for, YYYY-MM-DD. Said after midnight, \'tomorrow\' can mean either date — ask when it is unclear.' }, rules: { type: 'array', description: 'Ordered conditions, first match wins. Required when engaging.', items: { type: 'object', properties: { hours: { type: 'array', items: { type: 'integer' }, description: "Hours of that morning, 0-23 local, that must ALL be Fair or better — 'fair at 8 through 9' is [8, 9]. Empty for an unconditional 'otherwise', which must be last." }, not_fair: { type: 'array', items: { type: 'integer' }, description: 'Optional hours, 0-23 local, of which NONE may be Fair or better — for when a condition depends on the good window being short.' }, wake: { type: 'string', description: 'Alarm time when this rule matches, HH:MM 24-hour.' } }, required: ['hours', 'wake'] } }, engaged: { type: 'boolean', description: 'Omit or true to set it; false to turn it off.' } }, required: ['day'] } },
    { name: 'set_alarm', description: "Make an existing dated item RING, or stop it ringing — 'make that one an alarm', 'wake me up for that', 'that one should be an alarm', or 'take the alarm off that', 'just notify me for that one'. An alarm rings on the TV and on any open hub app until he stops it; an ordinary dated item notifies quietly. Only ever from what he actually said — never from what the item is. Identify it by id from get_due or get_lists.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Item id or its leading characters.' }, list_id: listIdProp(roster, 'Optional — narrow the id search to one list. Omit to search every list.'), alarm: { type: 'boolean', description: 'True to make it ring, false to go back to an ordinary notification.' } }, required: ['id', 'alarm'] } },
    { name: 'create_list', description: "Start a NEW list — 'start a packing list', 'make me a list for the trip'. This is the ONLY way a list comes into existence: add_to_list will not create one, so a name he has not asked to be a new list is a mistake rather than a new list. Check get_lists first when it is unclear whether he means an existing one — 'put it on my book list' means the list that is already there. Returns the new list's id, which is what every later call uses.", inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'What to call it, in his words — the label only, no id.' }, emoji: { type: 'string', description: 'Optional single emoji for the list; it leads the notification when a dated item on it comes due.' }, priority: { type: 'number', description: 'Optional default for NEW items on this list: 1 important, 0 normal, -1 exempt. Omit for 0.' } }, required: ['name'] } },
    { name: 'delete_list', description: "Delete an ENTIRE list and everything on it ('delete my books list', 'get rid of that list'). Removes the list and all its items, permanently.", inputSchema: { type: 'object' as const, properties: { list_id: listIdProp(roster, 'Which list to delete.') }, required: ['list_id'] } },
  ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args || {};

  // Soft macro/calorie warnings ride back with whatever was written, never blocking it.
  function warnBlock(warns: string[]): string {
    return warns.length ? '\n\n⚠️ Macro check — these look off, double-check them:\n' + warns.map((w) => `- ${w}`).join('\n') : '';
  }
  function text(msg: string) {
    return { content: [{ type: 'text' as const, text: msg }] };
  }

  try {
    if (name === 'get_location') return text(await location.lastLocation());
    if (name === 'get_surf') return text(await surf.surfReport(Number(a.days) || 2));
    if (name === 'get_health_data') return text(await appleHealth.getHealthData(a as any));
    if (name === 'get_health_profile') {
      const profile = await health.getProfile();
      const weights = await health.recentWeights();
      const targets = await health.recentTargets();
      const produce = await health.produceTargets();
      return text(health.formatProfile(profile, weights, targets, produce));
    }
    if (name === 'set_height') {
      await health.setHeight(a.height_in as number);
      const h = a.height_in as number;
      return text(`Height set to ${h} in (${Math.floor(h / 12)}'${Math.floor(h % 12)}").`);
    }
    if (name === 'log_weight') {
      const entry = await health.logWeight(a.weight_lbs as number, a.date as string | undefined);
      return text(`Logged ${entry.weight_lbs} lbs on ${entry.date}.`);
    }
    if (name === 'update_weight') {
      const entry = await health.updateWeight(a.id as number, a as { weight_lbs?: number; date?: string });
      if (!entry) return text(`Weight entry not found: ${a.id}`);
      return text(`Entry ${entry.id} is now ${entry.weight_lbs} lbs on ${entry.date}.`);
    }
    if (name === 'remove_weight') {
      const entry = await health.removeWeight(a.id as number);
      if (!entry) return text(`Weight entry not found: ${a.id}`);
      return text(`Removed ${entry.weight_lbs} lbs from ${entry.date} (entry ${entry.id}).`);
    }
    if (name === 'get_nutrition_targets') {
      const targets = await health.recentTargets();
      const produce = await health.produceTargets();
      if (!targets.length) return text(`No nutrition targets set yet.\n\n${health.formatProduceTargets(produce)}`);
      const t = targets[0];
      const lines = [`Current nutrition targets (as of ${t.date}): ${t.calories} cal, ${t.protein_g}g protein, ${t.carbs_g}g carbs, ${t.fat_g}g fat`];
      if (targets.length > 1) {
        lines.push(`\nTarget history (last ${targets.length}):`);
        for (const e of targets) lines.push(`  ${e.date}: ${e.calories} cal, ${e.protein_g}g P / ${e.carbs_g}g C / ${e.fat_g}g F`);
      }
      lines.push(`\n${health.formatProduceTargets(produce)}`);
      return text(lines.join('\n'));
    }
    if (name === 'set_nutrition_targets') {
      const entry = await health.setNutritionTargets({ calories: a.calories as number, protein_g: a.protein_g as number, carbs_g: a.carbs_g as number, fat_g: a.fat_g as number }, a.date as string | undefined);
      return text(`Nutrition targets set (${entry.date}): ${entry.calories} cal, ${entry.protein_g}g protein, ${entry.carbs_g}g carbs, ${entry.fat_g}g fat`);
    }
    if (name === 'get_workout_catalog') {
      const catalog = await workouts.getCatalog();
      const fmtMuscles = (m: Record<string, number>) => Object.entries(m).map(([k, v]) => `${k} ${v}`).join(', ');
      return text(
        `Valid categories: ${catalog.categories.join(', ')}\n` +
        `Valid muscles: ${catalog.muscles.join(', ')}\n` +
        `Exercises (${catalog.exercises.length}) — pass the id, never the name:\n` +
        (catalog.exercises.map(e => `  id=${e.id}  ${e.name} [${e.categories.join(', ')}] → ${fmtMuscles(e.muscles) || '(no map)'}`).join('\n') || '  none yet'));
    }
    if (name === 'get_shopping_items') {
      return text(shopping.formatItems(await shopping.listItems(a.retailer as string | undefined)));
    }
    if (name === 'build_walmart_cart_url') {
      return text(await shopping.walmartCartUrl(a.items as any[]));
    }
    if (name === 'save_shopping_item') {
      return text(await shopping.saveItem(a as any));
    }
    if (name === 'get_walmart_cart') {
      return text(shopping.formatCart(await shopping.getCart()));
    }
    if (name === 'record_walmart_cart') {
      return text(await shopping.setCart(a.items as any[], {
        unit_count: a.unit_count as number | undefined,
        subtotal: a.subtotal as number | undefined,
        savings: a.savings as number | undefined,
        source: 'session',
      }));
    }
    if (name === 'get_weekly_volume') {
      const result = await workouts.getWeeklyVolume((a.days as number) || 7);
      return text(workouts.formatWeeklyVolume(result));
    }
    if (name === 'log_set') {
      await workouts.logSets(a.sets as any[]);
      return text(await workouts.formatDay());
    }
    if (name === 'set_rep_watcher') {
      const w = await workouts.setWatcher(a.exercise_id as number, a.weight_lbs as number);
      return text(workouts.formatWatcher(w));
    }
    if (name === 'get_rep_watcher') {
      return text(workouts.formatWatcher(await workouts.getWatcher()));
    }
    if (name === 'clear_rep_watcher') {
      await workouts.clearWatcher();
      return text('Set watcher off.');
    }
    if (name === 'upsert_catalog_exercise') {
      const e = await workouts.upsertCatalogExercise(a.name as string, a.categories, a.muscles);
      const mus = Object.entries(e.muscles).map(([k, v]) => `${k} ${v}`).join(', ');
      return text(`Catalog saved: ${e.name} [${e.categories.join(', ')}] → ${mus}`);
    }
    if (name === 'list_workouts') {
      const days = await workouts.listWorkoutDays((a.limit as number) || 10);
      if (!days.length) return text('No workouts logged.');
      return text(days.map(d => `${d.date}  ${workouts.categoryLabel(d.categories)}  ${d.start}–${d.end}  ${d.setCount} sets  in order done: ${d.exercises.join(' → ')}`).join('\n'));
    }
    if (name === 'get_workout') {
      return text(await workouts.formatDay((a.date as string || '').trim() || undefined));
    }
    if (name === 'get_exercise_history') {
      const hist = await workouts.getExerciseHistory((a.name as string).trim(), (a.limit as number) || 60);
      if (!hist.length) return text(`No history found for '${a.name}'.`);
      const lines = [`History for ${a.name} (${hist.length} days, newest day first; each day's sets in the order done):`];
      for (const h of hist) lines.push(`  ${h.date}: ${h.sets.map(s => `${s.time} ${s.weight_lbs}x${s.reps}${s.note ? ` (${s.note})` : ''}`).join(', ')}`);
      return text(lines.join('\n'));
    }
    if (name === 'update_set') {
      const r = await workouts.updateSet(a.id as number, a as { exercise_id?: number; weight_lbs?: number; reps?: number; occurred_at?: string; note?: string });
      if (!r) return text(`Set not found: ${a.id}`);
      return text(await workouts.formatDay(r.occurred_at.slice(0, 10)));
    }
    if (name === 'remove_set') {
      const r = await workouts.removeSet(a.id as number);
      if (!r) return text(`Set not found: ${a.id}`);
      return text(`Removed set ${a.id} (${r.exercise} ${r.weight_lbs}x${r.reps}).\n\n` + await workouts.formatDay(r.occurred_at.slice(0, 10)));
    }
    if (name === 'list_recipes') {
      const tag = (a.tag as string || '').trim() || undefined;
      const list = await recipes.listRecipes(tag);
      if (!list.length) return text(tag ? `No recipes tagged '${tag}'.` : 'No recipes saved yet.');
      return text(recipes.formatRecipeList(list));
    }
    if (name === 'get_recipe') {
      const r = await recipes.getRecipe(a.name as string);
      if (!r) return text(`Recipe not found: ${a.name}`);
      return text(recipes.formatRecipe(r));
    }
    if (name === 'save_recipe') {
      const saved = a.from_entry
        ? await nutrition.saveEntryAsRecipe((a.from_entry as string).trim(), a as any)
        : await recipes.saveRecipe(a as any);
      if (!saved) return text(`Nutrition entry not found: ${a.from_entry}`);
      const from = 'from' in saved ? ` from the logged '${(saved as { from: { name: string } }).from.name}'` : '';
      return text(`${saved.action} recipe: ${saved.recipe.name}${from}\n\n` + recipes.formatRecipe(saved.recipe) + warnBlock(saved.warnings));
    }
    if (name === 'delete_recipe') {
      const r = await recipes.deleteRecipe(a.name as string);
      if (!r) return text(`Recipe not found: ${a.name}`);
      return text(`Deleted recipe: ${r.name}`);
    }
    if (name === 'log_recipe') {
      const stage = a.stage === true;
      const item = { recipe: (a.recipe as string).trim(), servings: a.servings as number | undefined, occurred_at: a.occurred_at as string | undefined };
      const [entry] = stage ? await nutrition.stageNutrition([item]) : await nutrition.logNutrition([item]);
      const servings = entry.quantity !== 1 ? ` (${entry.quantity} servings)` : '';
      if (stage) return text(`Staged ${entry.name}${servings}.\n\n` + nutrition.formatStagedList(await nutrition.getStaged()));
      return text(`Logged ${entry.name}${servings}.\n\n` + nutrition.formatNutritionDay(entry.date, await nutrition.getNutrition(entry.date)));
    }
    if (name === 'log_nutrition') {
      const entries = await nutrition.logNutrition(a.items as any[]);
      const day = entries[0]?.date || '';
      const allEntries = await nutrition.getNutrition(day);
      return text(nutrition.formatNutritionDay(day, allEntries) + warnBlock(entries.flatMap((e) => e.warnings || [])));
    }
    if (name === 'get_nutrition') {
      const day = (a.date as string || '').trim() || undefined;
      const entries = await nutrition.getNutrition(day);
      return text(nutrition.formatNutritionDay(day || entries[0]?.date || '', entries));
    }
    if (name === 'delete_nutrition_entry') {
      const entry = await nutrition.deleteNutritionEntry((a.id as string).trim());
      if (!entry) return text(`Entry not found: ${a.id}`);
      const dayEntries = await nutrition.getNutrition(entry.date);
      return text(`Deleted: ${entry.name}\n\n` + nutrition.formatNutritionDay(entry.date, dayEntries));
    }
    if (name === 'edit_nutrition_entry') {
      const entry = await nutrition.editEntry((a.id as string).trim(), false, { name: a.name as string, nutrition: a.nutrition as any, ingredients: a.ingredients as any, occurred_at: a.occurred_at as string });
      if (!entry) return text(`Entry not found: ${a.id}`);
      return text(`Updated: ${entry.name}\n\n` + nutrition.formatNutritionDay(entry.date, await nutrition.getNutrition(entry.date)) + warnBlock(entry.warnings ?? []));
    }
    if (name === 'subtract_leftovers') {
      const res = await nutrition.subtractLeftovers((a.id as string).trim(), a.grams as number, a.total_g as number | undefined);
      if (!res) return text(`Entry not found: ${a.id}`);
      const { entry, total_g, eaten_g, factor, before, assumedTotal } = res;
      const dayEntries = await nutrition.getNutrition(entry.date);
      const pct = Math.round(factor * 1000) / 10;
      return text(
        `Subtracted ${a.grams} g of leftovers from **${entry.name}** — ` +
        `${eaten_g} g eaten of ${total_g} g${assumedTotal ? ' (total weight supplied)' : ''}, so every ingredient scaled to ${pct}%.\n\n` +
        `${before.calories} → ${entry.calories} cal · ` +
        `P ${before.protein_g} → ${entry.protein_g} · C ${before.carbs_g} → ${entry.carbs_g} · F ${before.fat_g} → ${entry.fat_g}\n\n` +
        nutrition.formatNutritionDay(entry.date, dayEntries));
    }
    if (name === 'stage_meal') {
      const staged = await nutrition.stageNutrition(a.items as any[]);
      return text(`Staged ${staged.length} meal${staged.length === 1 ? '' : 's'}.\n\n` + nutrition.formatStagedList(await nutrition.getStaged()) + warnBlock(staged.flatMap((e) => e.warnings || [])));
    }
    if (name === 'list_staged') {
      return text(nutrition.formatStagedList(await nutrition.getStaged()));
    }
    if (name === 'commit_staged') {
      const entry = await nutrition.commitStaged((a.id as string).trim());
      if (!entry) return text(`Staged meal not found: ${a.id}`);
      const dayEntries = await nutrition.getNutrition(entry.date);
      return text(`Committed (logged now): ${entry.name}\n\n` + nutrition.formatNutritionDay(entry.date, dayEntries));
    }
    if (name === 'edit_staged') {
      const entry = await nutrition.editEntry((a.id as string).trim(), true, { name: a.name as string, nutrition: a.nutrition as any, ingredients: a.ingredients as any });
      if (!entry) return text(`Staged meal not found: ${a.id}`);
      return text(`Updated staged meal: ${entry.name}\n\n` + nutrition.formatStagedList(await nutrition.getStaged()) + warnBlock(entry.warnings ?? []));
    }
    if (name === 'remove_staged') {
      const entry = await nutrition.removeStaged((a.id as string).trim());
      if (!entry) return text(`Staged meal not found: ${a.id}`);
      return text(`Removed staged meal: ${entry.name}\n\n` + nutrition.formatStagedList(await nutrition.getStaged()));
    }

    if (name === 'reload_wall') {
      // The kiosk chromium runs on the Pi; the .xinitrc launch loop relaunches it after a kill. This MCP
      // normally runs on the Mac (worker primary) → ssh to the Pi; if it's running ON the Pi, kill locally.
      const onPi = hostname().toLowerCase().includes('raspberrypi');
      try {
        if (onPi) execFileSync('pkill', ['-x', 'chromium'], { timeout: 5000 });
        else execFileSync('ssh', ['pi', 'pkill -x chromium'], { timeout: 8000 });
      } catch (e: any) {
        // pkill exits 1 when nothing matched (chromium already down — the loop still relaunches it): fine.
        if (!e || e.status !== 1) return text(`Couldn't reach the wall to reload it: ${e?.message || e}`);
      }
      return text('Reloading the wall display — chromium will relaunch in a few seconds.');
    }

    if (name === 'get_due') {
      const days = a.days != null ? Math.max(0, Number(a.days)) : lists.DUE_DEFAULT_DAYS;
      return text(lists.formatDueItems(await lists.dueItems(days)));
    }
    if (name === 'get_lists') {
      const all = await lists.allLists();
      if (!all.length) return text('No lists yet.');
      const block = async (l: lists.List) => lists.formatListItems(await lists.listItems(l.id), l);
      if (a.list_id) {
        const want = String(a.list_id).trim();
        const match = all.find((l) => l.id === want);
        if (match) return text(await block(match));
        // An unknown id shows the real lists rather than an empty one — a mismatch must never read
        // back as "that list is empty", which is the failure this whole id scheme exists to stop.
        const blocks = await Promise.all(all.map(block));
        return text(`No list with id "${a.list_id}". Your lists:\n\n` + blocks.join('\n\n'));
      }
      return text((await Promise.all(all.map(block))).join('\n\n'));
    }
    if (name === 'create_list') {
      const made = await lists.createList(String(a.name), {
        emoji: a.emoji ? String(a.emoji) : null,
        default_priority: a.priority != null ? Number(a.priority) : undefined,
      });
      // A new list changes the enum on every list tool, so the schema the client is holding is now
      // wrong. This is the notification that says so.
      await server.sendToolListChanged().catch(() => {});
      return text(`Created **${made.name}** — its id is \`${made.id}\`, which is what add_to_list takes.`);
    }
    if (name === 'add_to_list') {
      // An unknown id throws out of `requireList` with the valid ones named. It cannot create a list:
      // that is `create_list`, and the separation is what makes a wrong id rejectable (00094).
      const made = await lists.addItem(String(a.list_id || lists.DEFAULT_LIST_ID), String(a.text), {
        title: a.title ? String(a.title) : undefined,
        due: a.due ? String(a.due) : undefined,
        priority: a.priority != null ? Number(a.priority) : undefined,
        repeat_every: a.repeat_every ? String(a.repeat_every) : undefined,
        repeat_until: a.repeat_until ? String(a.repeat_until) : undefined,
        alarm: a.alarm === true,
      });
      const first = made[0];
      const flag = (first.priority > 0 ? ' (important)' : first.priority < 0 ? ' (exempt)' : '')
        + (first.alarm ? ' (alarm)' : '');
      // A series reports its span rather than its rows: the caller asked for one thing and a list of
      // thirty near-identical lines says less about what was committed to than the range does.
      const when = made.length > 1
        ? ` — ${made.length} occurrences, ${first.due} through ${made[made.length - 1].due}`
        : (first.due ? ` — due ${first.due}` : '');
      const list = await lists.requireList(first.list_id);
      return text(`Added to **${list.name}**: ${lists.itemLabel(first)}${when}${flag}\n\n`
        + lists.formatListItems(await lists.listItems(list.id), list));
    }
    if (name === 'set_due') {
      const where = a.list_id ? String(a.list_id) : null;
      const patch: { due?: string | null } = {};
      if ('due' in a) patch.due = a.due ? String(a.due) : null;
      const it = await lists.setDue(where, String(a.id), patch);
      if (!it) return text(`No item matched id '${a.id}'${where ? ` on '${where}'` : ''}.`);
      if (!it.due) return text(`**${lists.itemLabel(it)}** (${it.list_name}) no longer has a due date, so it will not fire.`);
      return text(`**${lists.itemLabel(it)}** (${it.list_name}) is now due ${it.due}.`);
    }
    if (name === 'set_priority') {
      const where = a.list_id ? String(a.list_id) : null;
      const it = await lists.setPriority(where, String(a.id), Number(a.priority));
      if (!it) return text(`No item matched id '${a.id}'${where ? ` on '${where}'` : ''}.`);
      const how = it.priority > 0 ? 'important' : it.priority < 0 ? 'exempt — it will not be scored, and closes itself when the time passes' : 'normal priority';
      return text(`**${lists.itemLabel(it)}** (${it.list_name}) is ${how}.`);
    }
    if (name === 'set_surf_alarm') return text(await surf.setSurfAlarm(String(a.day), a.rules, a.engaged !== false));
    if (name === 'set_alarm') {
      const where = a.list_id ? String(a.list_id) : null;
      const it = await lists.setAlarm(where, String(a.id), a.alarm === true);
      if (!it) return text(`No item matched id '${a.id}'${where ? ` on '${where}'` : ''}.`);
      if (!it.alarm) return text(`**${lists.itemLabel(it)}** (${it.list_name}) will notify quietly, not ring.`);
      // An alarm with no moment has nothing to ring at, and saying "it will ring" would be a lie.
      if (!it.due) return text(`**${lists.itemLabel(it)}** (${it.list_name}) is marked as an alarm, but it has no due date yet — give it one with set_due and it will ring then.`);
      return text(`**${lists.itemLabel(it)}** (${it.list_name}) will RING at ${it.due}.`);
    }
    if (name === 'complete_item') {
      const where = a.list_id ? String(a.list_id) : null;
      const it = await lists.completeItem(where, String(a.id), { undo: !!a.undo, at: a.at ? String(a.at) : undefined });
      if (!it) return text(`No matching item for id '${a.id}'${where ? ` in '${where}'` : ''}.`);
      if (a.undo) return text(`Back on **${it.list_name}**: ${lists.itemLabel(it)}\n\n`
        + lists.formatListItems(await lists.listItems(it.list_id), await lists.requireList(it.list_id)));
      const late = it.due ? lists.lateness(it) : null;
      return text(`Done: ${lists.itemLabel(it)}${late ? ` (${late})` : ''}\n\n`
        + lists.formatListItems(await lists.listItems(it.list_id), await lists.requireList(it.list_id)));
    }
    if (name === 'remove_from_list') {
      const where = a.list_id ? String(a.list_id) : null;
      const it = await lists.removeItem(where, String(a.id));
      if (!it) return text(`No matching item for id '${a.id}'${where ? ` in '${where}'` : ''}.`);
      let extra = '';
      if (a.series && it.series_id) {
        const rest = await lists.removeSeries(it.series_id);
        extra = ` and ${rest.length} further occurrence${rest.length === 1 ? '' : 's'}`;
      }
      return text(`Removed from **${it.list_name}**: ${lists.itemLabel(it)}${extra}\n\n`
        + lists.formatListItems(await lists.listItems(it.list_id), await lists.requireList(it.list_id)));
    }
    if (name === 'set_list_priority') {
      const hit = (await lists.setListDefaultPriority(String(a.list_id), Number(a.priority))).name;
      const p = Math.max(-1, Math.min(1, Math.round(Number(a.priority) || 0)));
      const how = p > 0 ? 'important' : p < 0 ? 'exempt' : 'normal';
      return text(`New items on **${hit}** now default to ${how}. Items already on it are unchanged.`);
    }
    if (name === 'set_list_emoji') {
      const hit = await lists.setListEmoji(String(a.list_id), a.emoji ? String(a.emoji) : null);
      return text(a.emoji ? `**${hit.name}** is now ${a.emoji}.` : `Removed the emoji from **${hit.name}**.`);
    }
    if (name === 'list_repos') {
      const rows = await desk.listRepos();
      if (!rows.length) return text('No projects published.');
      return text(rows.map((r) => `- ${r.name}${r.branch && r.branch !== 'main' ? ` (${r.branch})` : ''}`).join('\n'));
    }
    if (name === 'publish_report') {
      const id = await reports.publishReport(String(a.title || ''), String(a.summary || ''), String(a.html || ''));
      return text(`Published. Jared gets a notification; the page is at /report/${id}.`);
    }
    if (name === 'start_session') {
      const machine = String(a.machine || 'pi').toLowerCase() === 'mac' ? 'mac' : 'pi';
      // `required` in the schema is a hint the caller can ignore, and one did — this refusal is what
      // makes the label a guarantee. A dispatch has no other source of a name: nothing downstream
      // invents one, so an unlabelled row reads '(unnamed)' for good. Refusing is cheap because the
      // caller simply retries with a label, where a silent default would be wrong on every row.
      const label = String(a.label || '').trim();
      if (!label) return text('No label. Pass `label`: three to six words naming the job — the product, the cart, the file it acts on.');
      // A dispatched session handing its OWN request back to start_session would open a second session
      // for the same work: the words it was given can still say "start a session in X and have it...",
      // and that reads like an order. The launchers tell it otherwise; this is the guarantee.
      if (await desk.redispatch(process.env.HUB_SESSION_ID, String(a.prompt || ''))) {
        return text('Not started: you ARE the session this request was dispatched to. Do the work yourself.');
      }
      // DATA_CALLER=hub is set by the voice worker alone, so only a dispatch from the hub conversation
      // has its first reply relayed back into that thread; another agent's dispatch stays out of it.
      const r = await desk.startSession(a.repo ? String(a.repo) : undefined, String(a.prompt || ''), machine as desk.Machine, a.report === true, label, process.env.DATA_CALLER === 'hub');
      if (!r.ok) return text(r.error);
      const where = r.repo === 'root' ? 'the home directory' : `**${r.repo}**`;
      const back = process.env.DATA_CALLER === 'hub'
        ? 'Its first reply is posted into the hub conversation when it finishes.'
        : 'It runs on its own; check back with get_sessions.';
      const on = desk.machineName(r.machine);
      // Said whenever the work is not where the caller asked, so the reply can tell him where it went.
      // A login repair is started only when a machine of his still works (desk.ts startSession); Fly
      // gets the caveat instead, since it cannot do what needs his signed-in browser.
      const moved = r.rerouted
        ? ` It went to the ${on} instead of the machine asked for, because ${r.rerouted}.`
          + (r.machine === 'fly'
            ? ' The Fly machine has no browser, so anything needing his signed-in accounts cannot be done there.'
            : /login/.test(r.rerouted) ? ' A separate session has been started to renew that login.' : '')
        : '';
      if (r.state === 'queued') {
        return text(`NOT started yet: "${label}" is queued on the ${on} (${r.detail.replace(/^queued\s*[—-]?\s*/, '')}). It launches when the ${on} has room; get_sessions lists it under Queued.${moved}`);
      }
      if (r.state === 'unconfirmed') {
        return text(`Sent "${label}" to the ${on}, but the ${on} has not confirmed it launched. Check get_sessions before saying it started.${moved}`);
      }
      const why = r.handedOff ? ` The Pi had no room (${r.handedOff}), so it went to the Mac.` : '';
      return text(`Started "${label}" in ${where} on the ${on}.${moved}${why} ${back}`);
    }
    if (name === 'follow_up') {
      const r = await desk.followUp(String(a.prompt || ''), a.session ? String(a.session) : undefined);
      return text(!r.ok ? r.error
        : r.confirmed ? `Delivered to the ${r.repo} session.`
        : `Queued for the ${r.repo} session, but its machine has not confirmed delivery yet.`);
    }
    if (name === 'get_sessions') {
      const rows = await desk.listSessions();
      return text(desk.formatSessions(rows, await desk.queued(), await desk.turnSummaries(rows)));
    }
    if (name === 'bedroom_tv') {
      const op = String(a.op || '') as bedroomTv.Op;
      if (!bedroomTv.OPS.includes(op)) return text(`Unknown op ${op}.`);
      const args: Record<string, unknown> = {};
      if (a.value !== undefined) args.value = Number(a.value);
      if (op === 'open') { args.url = String(a.url || ''); if (a.app) args.package = bedroomTv.APPS[String(a.app)]; }
      if (op === 'launch') {
        const pkg = bedroomTv.APPS[String(a.app || '')];
        if (!pkg) return text(`Unknown app ${a.app}.`);
        args.package = pkg;
      }
      if (op === 'sidebar' || op === 'power') args.on = a.on !== false;
      if (op === 'overlay') { args.text = String(a.text || ''); if (a.seconds) args.seconds = Number(a.seconds); }
      return text(JSON.stringify(await bedroomTv.command(op, args)));
    }
    if (name === 'youtube') {
      const op = String(a.op || '');
      const limit = a.limit ? Number(a.limit) : undefined;
      if (op === 'search') return text(await youtube.search(String(a.query || ''), limit));
      if (op === 'video') return text(await youtube.video(String(a.id || '')));
      if (op === 'related') return text(await youtube.related(String(a.id || ''), limit));
      if (op === 'channel') return text(await youtube.channel(String(a.id || ''), limit));
      if ((youtubeAccount.OPS as readonly string[]).includes(op))
        return text(await homeRequests.ask('youtube_account', { op, limit, id: a.id, shorts: a.shorts === true }));
      return text(`Unknown op ${op}.`);
    }
    if (name === 'catalog') {
      const c = a as any;
      const op = String(a.op || '');
      const limit = a.limit ? Number(a.limit) : undefined;
      if (op === 'search') return text(await catalog.search(String(a.query || ''), { type: c.type, limit }));
      if (op === 'title') return text(await catalog.title(String(a.id || '')));
      if (op === 'episodes') return text(await catalog.episodes(String(a.id || '')));
      if (op === 'popular') return text(await catalog.popular({ services: c.services, type: c.type, genres: c.genres, sort: c.sort,
        year_min: c.year_min, year_max: c.year_max, imdb_min: c.imdb_min, limit }));
      if (op === 'added') return text(await catalog.added({ services: c.services, days: c.days, type: c.type, limit }));
      return text(`Unknown op ${op}.`);
    }
    if (name === 'set_wall') {
      const raw = String(a.mode || '').toLowerCase();
      const mode = (['sessions', 'calendar', 'health'].includes(raw) ? raw : 'standard') as desk.WallMode;
      const months = Number(a.months);
      const r = await desk.setWall(mode, Number.isInteger(months) && months >= 1 && months <= 12 ? months : undefined);
      // 'home' is a second word for the default and normalises to 'standard' above, so it is never
      // stored — say the word he used rather than the value written.
      const said = raw === 'home' || mode === 'standard' ? 'home' : mode === 'sessions' ? 'session' : mode;
      return text(r.ok ? `TV switched to the ${said} wall.` : r.error);
    }
    if (name === 'focus_session') {
      const r = await desk.focusSession(String(a.session || ''));
      if (!r.ok) return text(r.error);
      return text(`Pinned ${r.label || r.repo}. Follow-ups go there until he pins another, unpins it, something new is dispatched, or it closes.`);
    }
    if (name === 'unfocus_session') {
      const r = await desk.unfocusSession();
      return text(r.session ? `Unpinned. Follow-ups go to whichever session is most recently active — right now that is ${r.label || r.repo}.`
                            : 'Unpinned. Nothing is running right now.');
    }
    if (name === 'rename_session') {
      const r = await desk.renameSession(String(a.session || ''), String(a.name || ''));
      if (!r.ok) return text(r.error);
      return text(r.live ? `Renamed it to "${r.name}".`
                         : `Renamed it to "${r.name}" in the list — it is not running, so the session itself takes the name when it is resumed.`);
    }
    if (name === 'transfer_session') {
      const machine = String(a.machine || '').toLowerCase() === 'mac' ? 'mac' : 'pi';
      const r = await desk.transferSession(String(a.session || ''), machine as desk.Machine);
      if (!r.ok) return text(r.error);
      const where = machine === 'mac' ? 'the Mac' : 'the Pi';
      return text(r.live
        ? `Closing the ${r.repo} session and picking it up on ${where} with its full conversation.`
        : `That machine is asleep, so ${where} is resuming the ${r.repo} session from the mirrored transcript — everything up to its last reply.`);
    }
    if (name === 'resume_session') {
      const r = await desk.sessionCommand('resume_session', String(a.session), a.prompt ? String(a.prompt) : undefined);
      // The machine answers "already running" when the session was open: nothing was reopened, and a
      // prompt went straight into the live session. Saying "resumed" there describes something that
      // did not happen.
      const already = r.ok && /already running/.test((r as any).detail || '');
      return text(!r.ok ? r.error
        : already ? (a.prompt ? 'That session was already running, so nothing was reopened — the words went straight to it.'
                              : 'That session was already running, so nothing was reopened.')
        : r.queued ? `NOT resumed yet: it is queued on the Pi (${r.detail.replace(/^queued resume of \S+\s*[—-]?\s*/, '')}). It resumes when there is room; get_sessions lists it under Queued.`
        : r.confirmed && r.handedOff ? `The Pi had no room (${r.handedOff}), so that session resumed on the Mac with its full context.`
        : r.confirmed ? 'Resumed that session with its full context.'
        : 'Queued the resume, but its machine has not confirmed it yet.');
    }
    if (name === 'end_session') {
      const r = await desk.sessionCommand('end_session', String(a.session));
      return text(r.ok ? 'Closing that session.' : r.error);
    }
    if (name === 'delete_list') {
      const deleted = await lists.removeList(String(a.list_id));
      // Removing a list changes the enum on every list tool, same as creating one.
      await server.sendToolListChanged().catch(() => {});
      return text(`Deleted the '${deleted.name}' list and all its items.`);
    }

    return text(`Unknown tool: ${name}`);
  } catch (err: any) {
    return text(`Error: ${err.message}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => { console.error('MCP server error:', err); process.exit(1); });
