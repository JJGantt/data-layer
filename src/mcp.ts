#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execFileSync } from 'child_process';
import { hostname } from 'os';
import * as health from './health.js';
import * as workouts from './workouts.js';
import * as nutrition from './nutrition.js';
import * as lists from './lists.js';
import * as desk from './desk.js';
import * as notes from './notes.js';
import * as reports from './reports.js';

const server = new Server({ name: 'data', version: '2.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'get_health_profile', description: 'Returns height, recent weight log entries, and current nutrition targets (calories, protein, carbs, fat).', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'set_height', description: 'Set or update height in inches.', inputSchema: { type: 'object' as const, properties: { height_in: { type: 'number', description: 'Height in inches (e.g. 72 for 6\'0").' } }, required: ['height_in'] } },
    { name: 'log_weight', description: 'Log a body weight entry. Appends to the weight log. ONLY call this with a weight the user EXPLICITLY stated as a number in their message. NEVER infer, estimate, guess, or fabricate a bodyweight, and NEVER back-fill multiple days from one request. If no explicit number was given — e.g. "log my weight" with no value, or a workout command like "add 10 rows body weight" (that is a SET of the Rows exercise, not a weigh-in) — do NOT call this tool; ask the user for the number instead.', inputSchema: { type: 'object' as const, properties: { weight_lbs: { type: 'number', description: 'Body weight in pounds — must be a value the user explicitly spoke.' }, date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' } }, required: ['weight_lbs'] } },
    { name: 'get_nutrition_targets', description: 'Get the current daily nutrition targets (calories, protein, carbs, fat) and recent target history.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'set_nutrition_targets', description: 'Set daily nutrition targets (calories, protein, carbs, fat). Appends a new entry to the target log so history is preserved. The most recent entry becomes the current target, shown in get_health_profile.', inputSchema: { type: 'object' as const, properties: { calories: { type: 'number', description: 'Daily calorie target.' }, protein_g: { type: 'number', description: 'Daily protein target in grams.' }, carbs_g: { type: 'number', description: 'Daily carbs target in grams.' }, fat_g: { type: 'number', description: 'Daily fat target in grams.' }, date: { type: 'string', description: 'Date these targets take effect (YYYY-MM-DD). Defaults to today.' } }, required: ['calories', 'protein_g', 'carbs_g', 'fat_g'] } },
    { name: 'get_workout_catalog', description: 'Returns the valid categories (push/pull/legs/core/cardio), the valid muscle slugs, and the canonical exercise library — each exercise with its numeric id, categories and fractional muscle map. Call this before log_set / update_set / set_rep_watcher: those tools take the exercise ID, never a name, so this is where the id comes from. Match what the user said to an exercise here regardless of how they said it — plural, singular or casing ("overhead tricep extensions" is id for Overhead Tricep Extension) — and pass that id. Only treat a movement as genuinely new if nothing here is the same exercise.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'log_set', description: "Log one or more sets to today's workout, with the reps STATED BY THE USER. If the user gives an exercise and weight but NO reps because the watch will count them, use set_rep_watcher instead. There is no session — each set is its own timestamped row, stamped NOW unless the set carries its own `occurred_at`, which is how you log a set that already happened ('add the set I did at 1:50'). Pass a 'sets' array. Each set names its movement by `exercise_id` from get_workout_catalog — call that FIRST and match what the user said to an entry there however they phrased it (plural, singular, casing); the id carries the name and muscle map, so there is nothing to spell. For a movement genuinely not in the catalog, call upsert_catalog_exercise first (it returns the new id) and log against that. weight_lbs is TOTAL weight (a '30 lb dumbbell' pair = 60); bodyweight = 0. Log set-by-set as you train (accurate rest timing) or several at once. Returns today's workout table — pass it to the user exactly as-is.", inputSchema: { type: 'object' as const, properties: { sets: { type: 'array', description: 'Sets to log: [{exercise_id, weight_lbs, reps, optional occurred_at}].', items: { type: 'object', properties: { exercise_id: { type: 'integer', description: 'Numeric id from get_workout_catalog. Never a name.' }, weight_lbs: { type: 'number', description: 'Total weight in lbs; bodyweight = 0.' }, reps: { type: 'integer' }, occurred_at: { type: 'string', description: "Optional. When this set actually happened, as LOCAL wall-clock 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD' for a bare day, which lands at noon) — the clock reading where he was, never UTC. Omit for a set happening now, which is the normal case; sets logged together without it share one timestamp." } }, required: ['exercise_id', 'weight_lbs', 'reps'] } } }, required: ['sets'] } },
    { name: 'set_rep_watcher', description: "Set the REP WATCHER: from now on, every set counted by the Apple Watch app is logged as this exercise at this weight, with its own timestamp. Triggered by the phrase 'rep watcher' — 'set the rep watcher to incline press at 80' — call get_workout_catalog and pass that exercise's id. HOW TO TELL THIS FROM log_set: this tool takes NO reps, because the watch supplies them. A stated rep count ('log 8 reps of incline press at 80') is log_set, one set now. An exercise and weight with no reps, said before training, is THIS tool. Must be set BEFORE the sets happen; a set the watch reports while the watcher is off is discarded rather than guessed at. Clears itself after ten minutes with no set. Does not replace log_set, which stays the way to log by hand.", inputSchema: { type: 'object' as const, properties: { exercise_id: { type: 'integer', description: 'Numeric id from get_workout_catalog. Never a name.' }, weight_lbs: { type: 'number', description: 'TOTAL weight in lbs; bodyweight = 0.' } }, required: ['exercise_id', 'weight_lbs'] } },
    { name: 'get_rep_watcher', description: 'Show what the rep watcher is set to and whether it is still live, i.e. whether sets counted by the watch are currently being logged.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'clear_rep_watcher', description: 'Clear the rep watcher, so sets counted by the watch stop being logged.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'upsert_catalog_exercise', description: 'Create a new exercise in the catalog, or edit an existing one (fix its categories or muscle map). Provide name, categories, and a fractional muscles map ({slug: contribution}, 0 < c <= 1). Editing REPLACES the muscle map. Because volume joins to the catalog at read time, edits retroactively correct all history.', inputSchema: { type: 'object' as const, properties: { name: { type: 'string' }, categories: { type: 'array', items: { type: 'string', enum: ['push', 'pull', 'legs', 'core', 'cardio'] } }, muscles: { type: 'object', additionalProperties: { type: 'number' }, description: 'Fractional map, e.g. {"quads":1.0,"glutes":0.5}.' } }, required: ['name', 'categories', 'muscles'] } },
    { name: 'list_workouts', description: 'List recent workout days (grouped from sets), newest first — date, derived category label, set count, and exercises.', inputSchema: { type: 'object' as const, properties: { limit: { type: 'integer', description: 'Max days to return. Defaults to 10.' } } } },
    { name: 'get_workout', description: "Get a day's full workout — all sets grouped by exercise. Defaults to today. Returns a pre-formatted table — pass it to the user exactly as-is.", inputSchema: { type: 'object' as const, properties: { date: { type: 'string', description: 'Date YYYY-MM-DD. Defaults to today.' } } } },
    { name: 'get_exercise_history', description: 'Get progression history for a single exercise across all days (most recent first).', inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Exercise name (case-insensitive).' }, limit: { type: 'integer', description: 'Max days to return. Defaults to 60.' } }, required: ['name'] } },
    { name: 'get_weekly_volume', description: 'Weekly hypertrophy volume per muscle (trailing N days, default 7), as fractional sets (primary mover = 1.0, secondary = 0.5) summed across all logged sets. Shows all muscle regions grouped by legs/push/pull/core against the ~10–20 sets/week target, so gaps (e.g. untrained hamstrings) are visible. Returns a pre-formatted report — pass it to the user exactly as-is.', inputSchema: { type: 'object' as const, properties: { days: { type: 'integer', description: 'Trailing window in days. Defaults to 7.' } } } },
    { name: 'update_set', description: "Correct a logged set by its set id (shown in get_workout) — its exercise, weight, reps, or the time it happened. Everything except `id` is optional and ONLY the fields you pass are changed, so fixing the weight leaves the reps and the timestamp exactly as they were; pass at least one. Use this to change which MOVEMENT a set was ('that last set was incline press, not chest press') rather than deleting and re-logging, because re-logging restamps the time and destroys the rest gap. The movement is named by `exercise_id` from get_workout_catalog, never by a name. `occurred_at` moves the set to a different time or day. Returns the day's table — pass it to the user exactly as-is.", inputSchema: { type: 'object' as const, properties: { id: { type: 'integer', description: 'Set id from get_workout.' }, exercise_id: { type: 'integer', description: 'Optional. Change which movement this set was, by its numeric id from get_workout_catalog.' }, weight_lbs: { type: 'number', description: 'Optional. Total weight in lbs; bodyweight = 0.' }, reps: { type: 'integer', description: 'Optional.' }, occurred_at: { type: 'string', description: "Optional. Move the set to another time, as LOCAL wall-clock 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD' for a bare day, which lands at noon). This is the clock reading where he was, never UTC." } }, required: ['id'] } },
    { name: 'remove_set', description: 'Delete a logged set by its set id (shown in get_workout).', inputSchema: { type: 'object' as const, properties: { id: { type: 'integer', description: 'Set id from get_workout.' } }, required: ['id'] } },
    { name: 'log_nutrition', description: "Log food ALREADY EATEN — it counts toward today's totals. Use this ONLY when the user says they ate/had it or says 'log'. If they say 'stage', 'staging', 'stage it', 'might eat', or 'for later', you MUST call stage_meal instead and NOT log it — honor the user's verb exactly; 'stage' is never a log. If the user REFERENCES a food they ate before ('the tofu dish I had yesterday', 'the same as last week', 'my usual oatmeal'), you MUST first call get_nutrition for that day, find the matching entry, and reuse its exact name and macros — never ask them to re-describe something already logged. If they name a food, record it as a structured ingredient carrying food + amount + unit and ESTIMATE its macros from standard nutrition knowledge (a scoop of protein powder ≈ 25 g protein, ~120 cal; one medium banana ≈ 105 cal). The amount/unit (the portion) is normally YOURS to choose from whatever quantity cue the user gives: an explicit measure ('a cup', '6 oz', 'a scoop') use it; a vague quantifier ('some', 'a bit', 'a handful', 'a small/large serving', 'a bowl') pick a reasonable concrete amount and unit; a count or naturally-single item ('a banana', 'two eggs', a bare countable food = one) use that count (the unit may be empty for bare counts). As long as there is ANY indication of quantity, NEVER ask — just pick a sensible amount and unit. Ask the user to clarify ONLY when EITHER (a) the FOOD ITSELF is unintelligible (audio cut off or garbled), OR (b) there is NO quantity indication at all on a food that needs one (e.g. 'add rice' with no amount and no natural single-unit default — a bulk food with zero quantity cue usually means the request got cut off). Keep the food NAME a PLAIN identity with NO quantity of any kind in it (no amounts, portions, counts, units, ingredient lists, or '(N×)' multiplier; e.g. 'Red wine', not 'Red wine (100 g)') — all quantity lives in the ingredient's amount and unit. Ingredient calories are optional (label calories trusted; else derived from the macros). The server stores every food as INGREDIENTS and computes the entry's calories/protein/carbs/fat by SUMMING them, so you never send a separate top-level total. For composite meals (e.g. an omelet, a stir-fry, overnight oats), include `ingredients`: an array with one entry per component, each with its OWN protein_g/carbs_g/fat_g (and calories when known). For each ingredient provide STRUCTURED fields — `food` (clean food name with NO amount or unit baked in, e.g. 'rolled oats', 'banana', 'protein powder'), `amount` (the numeric quantity these macros are for, e.g. 1, 0.5, 0.75), and `unit` (the measurement unit like 'cup', 'tbsp', 'g', 'scoop', 'slice', 'oz'; use an empty string or omit it for bare counts like 1 banana) — plus the macros (calories optional, protein_g/carbs_g/fat_g) for that amount. Keeping food/amount/unit separate lets the amounts be adjusted later. You may omit `name`; the server synthesizes a display name from food/amount/unit. The server derives the entry totals by summing the ingredients, so do NOT send a top-level total for a composite meal. For a single-component food, send it as ONE structured ingredient (food + amount + unit + macros); do not use the bare top-level `nutrition` field. Keep each component's calories roughly consistent with its protein/carbs/fat (≈4/4/9, allowing for fiber and alcohol) — the server soft-warns when they're wildly off, which usually signals a bad macro estimate. PRODUCE: every ingredient that is a fruit or vegetable must ALSO carry `produce_g` (its as-eaten weight in GRAMS, matching the portion you recorded) and `produce_type`. There are exactly three MUTUALLY EXCLUSIVE categories — pick exactly one per ingredient: (1) 'dark_green_vegetable' — vegetables that are DARK GREEN THROUGHOUT: spinach, kale, arugula, romaine and other dark leaf lettuce, salad/spring mix, chard, collards, bok choy, watercress, broccoli, broccolini, Brussels sprouts, asparagus, green beans, and green/snap peas. Broccoli and Brussels sprouts DO belong here. (2) 'other_vegetable' — every other vegetable: mushrooms, onion, cauliflower, cabbage, carrots, peppers of any colour, tomato, cucumber, celery, zucchini, iceberg lettuce, potato, sweet potato, corn, squash, and legumes/beans. Being merely green-SKINNED is not enough — cucumber, celery, zucchini, green peppers and iceberg lettuce are pale inside and belong here, not in dark green. (3) 'fruit' — fruits, including avocado. OMIT both fields entirely for grains, dairy, meat, eggs, oils, and condiments. Do NOT try to make a vegetable count toward both categories: the server adds leafy greens into the overall vegetable total automatically, so classify each ingredient once by what it actually is. For a mixed ingredient (salsa, a smoothie, a sauce), count only the produce share of its weight. When the portion is in a non-gram unit, convert for produce_g (1 cup raw leafy greens ≈ 30 g, 1 cup chopped broccoli ≈ 90 g, 1 medium apple ≈ 180 g, 1 medium banana ≈ 118 g, half an avocado ≈ 70 g). For recipe entries, provide a recipe name and optional servings. `occurred_at` is optional. Only include it if the user explicitly specifies a date or time; otherwise omit it. Always confirm what was logged by passing the result to the user as-is.", inputSchema: { type: 'object' as const, properties: { items: { type: 'array', description: 'List of food items eaten.', items: { oneOf: [ { type: 'object', properties: { name: { type: 'string', description: 'Plain food/dish name ONLY — the identity of the food, never any quantity. No amounts, portions, counts, units, ingredient lists, or "(N×)" multiplier anywhere in the name. Good: "Red wine", "Overnight oats", "Omelet", "Caffè latte", "Banana", "Protein powder". Bad: "Red wine (100 g)", "Banana (1/3)", "Protein powder (1 scoop)", "Three-egg omelet". All quantity lives in the macros and structured ingredients (which the UI scales); the name must stay valid no matter how the portion is later changed.' }, nutrition: { type: 'object', description: 'Macros for a SINGLE-component food (the server stores it as one ingredient and the entry totals equal these). For a composite meal, use `ingredients` instead. protein_g, carbs_g, and fat_g required; calories optional (label calories trusted, else derived).', properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } }, required: ['protein_g', 'carbs_g', 'fat_g'] }, ingredients: { type: 'array', description: 'Per-ingredient breakdown for composite meals (omelet, stir-fry, overnight oats). One entry per component, each with structured food/amount/unit so amounts can be adjusted later; the macros (and optional calories) are for that amount. The server SUMS the ingredients to get the entry totals. Use this for every food, including a single-component food (one ingredient with food/amount/unit).', items: { type: 'object', properties: { food: { type: 'string', description: "Clean food name with no amount or unit, e.g. 'rolled oats', 'banana', 'protein powder'." }, amount: { type: 'number', description: 'Numeric quantity these macros are for, e.g. 1, 0.5, 0.75.' }, unit: { type: 'string', description: "Measurement unit (cup, tbsp, tsp, g, ml, scoop, slice, oz, ...). Empty string or omit for bare counts like 1 banana." }, name: { type: 'string', description: 'Optional display name; omit when food/amount/unit are given and the server will synthesize it.' }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: "As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set (and only then). Convert from the portion unit: 1 cup raw leafy greens ≈ 30 g, 1 cup chopped broccoli ≈ 90 g, 1 medium apple ≈ 180 g, 1 medium banana ≈ 118 g, half an avocado ≈ 70 g. For a mixed ingredient (salsa, a sauce), count only the produce share of its weight." }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: "Set ONLY for fruits and vegetables, and pick exactly ONE — the three are mutually exclusive. 'dark_green_vegetable' = vegetables DARK GREEN THROUGHOUT: spinach, kale, arugula, romaine/dark leaf lettuce, salad mix, chard, collards, bok choy, watercress, broccoli, broccolini, Brussels sprouts, asparagus, green beans, green/snap peas. 'other_vegetable' = every other vegetable: mushrooms, onion, cauliflower, cabbage, carrots, peppers of any colour, tomato, cucumber, celery, zucchini, iceberg lettuce, potato, sweet potato, corn, squash, legumes/beans. Green SKIN is not enough — cucumber, celery, zucchini, green peppers and iceberg are pale inside and go in 'other_vegetable'. 'fruit' = fruits, including avocado. OMIT this field entirely for grains, dairy, meat, eggs, oils, and condiments. The server rolls dark greens into the overall vegetable total itself, so never make one ingredient count as both." } } } }, occurred_at: { type: 'string', description: 'Optional. Only include if the user explicitly specifies a date or time; otherwise omit.' } }, required: ['name'] }, { type: 'object', properties: { recipe: { type: 'string', description: 'Exact recipe name if this references a saved recipe.' }, servings: { type: 'number', description: 'Optional recipe serving multiplier. Defaults to 1.' }, occurred_at: { type: 'string', description: 'Optional. Only include if the user explicitly specifies a date or time; otherwise omit.' } }, required: ['recipe'] } ] } } }, required: ['items'] } },
    { name: 'get_nutrition', description: 'Get the nutrition log for a given date, including a daily totals summary.', inputSchema: { type: 'object' as const, properties: { date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' } } } },
    { name: 'delete_nutrition_entry', description: 'Remove a specific entry from the nutrition log by its ID.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Entry ID or 8-char prefix.' } }, required: ['id'] } },
    { name: 'subtract_leftovers', description: "Scale an ALREADY-LOGGED dish down by the weight the user did NOT eat. Use this whenever they give a leftover WEIGHT — 'I left 92 grams of that bowl', 'there was about 100 g left over', 'subtract 80 g from the stir-fry'. Every ingredient shrinks by the same fraction, because leftovers are a sample of the whole dish and not of one part of it, and the entry's calories/macros/produce are re-derived from the scaled ingredients. Identify the dish by ID or 8-char prefix — call get_nutrition first if you only know it by name. The dish's total cooked weight is worked out from the ingredients whose portions are already in grams, plus any produce (which carries its own gram weight). If an ingredient is portioned in a unit with no fixed gram weight — tofu by the block, rice by the cup, a scoop of something — the call FAILS and names them; estimate the whole dish's cooked weight yourself from standard food weights (a 14 oz block of tofu ≈ 396 g, 1 cup cooked rice ≈ 158 g, 1 cup cooked pasta ≈ 140 g) and pass it as total_g. Do NOT use this when the user gives a fraction or portion instead of a weight ('I only ate half') — that is a plain edit of the amounts, not a leftover subtraction.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Entry ID or 8-char prefix of the logged dish.' }, grams: { type: 'number', description: 'Weight in GRAMS left uneaten. Must be less than the dish total.' }, total_g: { type: 'number', description: "Optional. The dish's total cooked weight in grams. Needed only when an ingredient's portion cannot be weighed from its unit (block, cup, scoop, slice) — the error message names them when that happens." } }, required: ['id', 'grams'] } },
    { name: 'stage_meal', description: "Stage a meal the user MIGHT eat or will eat later, WITHOUT logging it as eaten — staged items do NOT count toward totals until committed. Whenever the user says 'stage', 'staging', 'stage it', 'might eat', or 'for later', use THIS tool — NEVER log_nutrition — even when they give full details; honor their verb exactly. If the user REFERENCES a food they ate before ('stage the tofu dish I had yesterday', 'the same as last week'), you MUST first call get_nutrition for that day, find the matching entry, and reuse its exact name and macros — never ask them to re-describe something already logged. If they name a food, record it as a structured ingredient carrying food + amount + unit and ESTIMATE its macros from standard nutrition knowledge. The amount/unit (the portion) is normally YOURS to choose from any quantity cue the user gives (an explicit measure; a vague quantifier like 'some'/'a bit'/'a handful'/'a small serving'; or a count / naturally-single item like 'a banana' = one). As long as there is ANY indication of quantity, NEVER ask — pick a sensible amount and unit. Ask ONLY when (a) the FOOD ITSELF is unintelligible, or (b) there is NO quantity indication at all on a food that needs one (e.g. 'add rice'). Same shape as log_nutrition: always structured `ingredients`, each carrying `food` + `amount` + `unit` and its own macros (calories optional, label calories trusted). The server stores every food as ingredients and sums them for the entry totals. PRODUCE: every ingredient that is a fruit or vegetable must ALSO carry `produce_g` (as-eaten weight in GRAMS) and `produce_type` — exactly one of three mutually exclusive categories: 'dark_green_vegetable' (dark green THROUGHOUT: spinach, kale, arugula, romaine, chard, broccoli, Brussels sprouts, asparagus, green beans, peas), 'other_vegetable' (every other vegetable: mushrooms, onion, cauliflower, cabbage, carrots, peppers, tomato, cucumber, celery, zucchini, potato, corn, legumes), or 'fruit' (including avocado). Broccoli IS dark green; cucumber/celery/zucchini/green peppers are only green-skinned and are not. Omit both fields for grains, dairy, meat, eggs, oils, and condiments. The server adds leafy greens into the overall vegetable total itself — classify each ingredient once by what it actually is. Staged meals are NOT counted in any totals until committed, they always surface in the current day's list, and they persist until committed or removed (no auto-expiry). Confirm by passing the result back to the user.", inputSchema: { type: 'object' as const, properties: { items: { type: 'array', description: 'Meals to stage.', items: { type: 'object', properties: { name: { type: 'string', description: 'Plain food/dish name ONLY — the food identity, never any quantity (no amounts, portions, counts, units, ingredient lists, or "(N×)" multiplier). Good: "Red wine", "Overnight oats". Bad: "Red wine (100 g)", "Three-egg omelet". Quantity lives in the macros/ingredients, which the UI scales.' }, nutrition: { type: 'object', properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } }, required: ['protein_g', 'carbs_g', 'fat_g'] }, ingredients: { type: 'array', description: 'Optional per-ingredient breakdown (same structured food/amount/unit + macros as log_nutrition).', items: { type: 'object', properties: { food: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string' }, name: { type: 'string' }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: 'As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set.' }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: "Set ONLY for fruits/vegetables; pick exactly one (mutually exclusive). 'dark_green_vegetable' = dark green THROUGHOUT (spinach, kale, arugula, romaine, chard, broccoli, Brussels sprouts, asparagus, green beans, peas). 'other_vegetable' = every other vegetable (mushrooms, onion, cauliflower, cabbage, carrots, peppers, tomato, cucumber, celery, zucchini, potato, corn, legumes). 'fruit' = fruits including avocado. Broccoli IS dark green; cucumber/celery/zucchini/green peppers are only green-skinned and are not. Omit for grains, dairy, meat, eggs, oils, condiments." } } } } }, required: ['name'] } } }, required: ['items'] } },
    { name: 'list_staged', description: 'List all staged (not-yet-eaten) meals with their IDs and macros.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'commit_staged', description: 'Commit a staged meal — log it as eaten right now so it counts toward today. Identify it by its ID or 8-char prefix.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Staged meal ID or 8-char prefix.' } }, required: ['id'] } },
    { name: 'edit_staged', description: "Edit a staged meal's name and/or ingredients; the server re-derives the entry totals from the ingredients. For a simple food you may pass `nutrition` (macros) and it's folded into the single ingredient. Identify it by ID or 8-char prefix.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Staged meal ID or 8-char prefix.' }, name: { type: 'string' }, nutrition: { type: 'object', properties: { calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' } } }, ingredients: { type: 'array', items: { type: 'object', properties: { food: { type: 'string' }, amount: { type: 'number' }, unit: { type: 'string' }, name: { type: 'string' }, calories: { type: 'number' }, protein_g: { type: 'number' }, carbs_g: { type: 'number' }, fat_g: { type: 'number' }, produce_g: { type: 'number', description: 'As-eaten weight of the produce itself, in GRAMS. Required whenever produce_type is set.' }, produce_type: { type: 'string', enum: ['dark_green_vegetable', 'other_vegetable', 'fruit'], description: "Set ONLY for fruits/vegetables; pick exactly one (mutually exclusive). 'dark_green_vegetable' = dark green THROUGHOUT (spinach, kale, arugula, romaine, chard, broccoli, Brussels sprouts, asparagus, green beans, peas). 'other_vegetable' = every other vegetable (mushrooms, onion, cauliflower, cabbage, carrots, peppers, tomato, cucumber, celery, zucchini, potato, corn, legumes). 'fruit' = fruits including avocado. Broccoli IS dark green; cucumber/celery/zucchini/green peppers are only green-skinned and are not. Omit for grains, dairy, meat, eggs, oils, condiments." } } } } }, required: ['id'] } },
    { name: 'remove_staged', description: 'Remove/delete a staged meal by ID or 8-char prefix. Does not affect committed entries.', inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Staged meal ID or 8-char prefix.' } }, required: ['id'] } },
    { name: 'reload_wall', description: 'Reload the TV wall display (the Pi kiosk browser). Use when the wall is frozen, blank, stale, or showing a crashed/"Aw Snap" page. Kills the kiosk chromium; the Pi automatically relaunches it fresh within a few seconds.', inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'get_due', description: "Everything with a due date, across all lists, soonest first — this is what his reminders are, since a reminder is just a dated item.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'get_lists', description: "Show Jared's lists (groceries, todos, packing, hardware, etc.). Omit `list` to see every list with its items; pass `list` to see just that one. Use when he asks what is on a list.", inputSchema: { type: 'object' as const, properties: { list: { type: 'string', description: "Optional list name to show only that list, e.g. 'groceries'. Omit to show all lists." } } } },
    { name: 'add_to_list', description: "Add an item to a list, which covers reminders too — a reminder is only an item with a `due` date, and anything dated fires a notification whichever list it is on. Omit `list` for the default todo list; an unknown list is created, so reuse an existing name when the intent is the same list.", inputSchema: { type: 'object' as const, properties: { list: { type: 'string', description: "List name, e.g. 'groceries'. Omit for the default 'todo' list." }, text: { type: 'string', description: 'The item itself, e.g. "milk" or "call the dentist". Do NOT bake date words into this — put times in `due`.' }, title: { type: 'string', description: 'Optional SHORT label (a few words) for narrow displays like the phone widget. Set this whenever `text` runs longer than a few words; put the gist here and the detail in `text`.' }, due: { type: 'string', description: 'Optional due date/time, ISO 8601 local (YYYY-MM-DD or YYYY-MM-DDTHH:MM). Setting it makes the item fire a notification then. Omit if no time was given.' }, repeat_every: { type: 'string', description: "Optional recurrence, as '<n> <unit>' — e.g. '1 day', '2 hours', '30 minutes', '1 week', '1 month', '1 year'. Use for 'every morning', 'every Monday', 'twice a day' (that is '12 hours'). Requires `due`, which sets the FIRST occurrence; the item re-arms itself for the next one each time it fires. Omit for a one-shot, which is the default — only set this when the thing genuinely recurs." } }, required: ['text'] } },
    { name: 'set_due', description: "Set, change or clear the due date or the recurrence on an existing item — 'remind me about the milk tomorrow at 9', 'push the dentist one to Friday', 'snooze that', or clear it so it stops firing. Identify the item by id from get_due or get_lists.", inputSchema: { type: 'object' as const, properties: { id: { type: 'string', description: 'Item id or its leading characters.' }, list: { type: 'string', description: 'Optional list to search; omit to search every list.' }, due: { type: 'string', description: 'New due date/time, ISO 8601 local (YYYY-MM-DD or YYYY-MM-DDTHH:MM). Pass empty to REMOVE the due date, which stops it firing. Omit entirely to leave the date alone.' }, repeat_every: { type: 'string', description: "New recurrence as '<n> <unit>' (e.g. '1 day'). Pass empty to make a repeating item one-shot without un-dating it. Omit entirely to leave the recurrence alone." } }, required: ['id'] } },
    { name: 'get_notes', description: "Read Jared's freeform notes. Omit `name` to list the note names; pass `name` to read that note's full content.", inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Optional note name to read its content. Omit to list all note names.' } } } },
    { name: 'create_note', description: "Create a note, or overwrite one that exists — to ADD to a note, read it with get_notes first and pass back the combined content.", inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Note name/title.' }, content: { type: 'string', description: 'The note body.' } }, required: ['name', 'content'] } },
    { name: 'remove_from_list', description: "Clear an item, which covers checking off, deleting and reminders alike — there is no separate completed state, and the removal is soft. Identify by id from get_lists or get_due.", inputSchema: { type: 'object' as const, properties: { list: { type: 'string', description: 'Optional list the item is on; omit to search every list.' }, id: { type: 'string', description: 'Item id or its leading characters (from get_lists or get_due).' } }, required: ['id'] } },
    { name: 'set_list_emoji', description: "Give a list an emoji, which leads the notification when a dated item on it comes due; empty removes it.", inputSchema: { type: 'object' as const, properties: { list: { type: 'string', description: "List name, e.g. 'grocery'." }, emoji: { type: 'string', description: 'A single emoji, e.g. "🛒". Empty removes it.' } }, required: ['list'] } },
    { name: 'list_repos', description: "Jared's projects, most recently worked on first. Call this when he names a project you are not sure of before using start_session — matching against the real list beats guessing at a name.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'start_session', description: "Start a Claude session on one of Jared's machines to do the work he just described. Pass his words through verbatim, minus the addressing ('in my X repo', 'send this to the Mac') — never summarise them.", inputSchema: { type: 'object' as const, properties: { repo: { type: 'string', description: "The project, if he named one. Omit when he did not or it is unclear — it then opens in his home directory, which is the right fallback rather than asking." }, prompt: { type: 'string', description: "What to do, word for word as he said it — rambling and self-corrections included, addressing stripped. Never summarise or tidy it; the session can read past disfluency, and rewriting loses what he actually said." }, label: { type: 'string', description: "A short name for the work — three to six words, always provided, naming the job rather than the repo." }, report: { type: 'boolean', description: "True only when he asks for a written write-up ('send me a report', 'write it up'). Otherwise omit." }, machine: { type: 'string', enum: ['pi', 'mac'], description: "Where to run it. Defaults to 'pi', which is almost always right; 'mac' only when he says so or for iOS work." } }, required: ['prompt'] } },
    { name: 'follow_up', description: "Send his words to the focused session, verbatim. ONLY when he hands them over — 'tell it to', 'send a follow-up', 'let it know' — or when this same utterance focused that session; the mic hears the whole room, so anything else he says is not for it.", inputSchema: { type: 'object' as const, properties: { prompt: { type: 'string', description: 'His words, verbatim.' } }, required: ['prompt'] } },
    { name: 'get_sessions', description: "The sessions running or parked on his machines, numbered as he refers to them, with what each last said.", inputSchema: { type: 'object' as const, properties: {} } },
    { name: 'set_wall', description: "Switch the TV between the standard dashboard, the sessions wall, and the calendar wall. When he sizes the calendar in the same breath ('show the full year', 'four months'), pass months too.", inputSchema: { type: 'object' as const, properties: { mode: { type: 'string', enum: ['standard', 'sessions', 'calendar'], description: 'Which wall to show.' }, months: { type: 'number', description: 'Calendar wall only: how many months it spreads across, 1-12 (a year is 12). Omit to leave the current spread alone.' } }, required: ['mode'] } },
    { name: 'focus_session', description: "Point at a running session; if this same utterance goes on to say what to do, send that part with follow_up. It does not carry past this utterance.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session: the NUMBER from get_sessions ('3'), the repo name, or words from its name." } }, required: ['session'] } },
    { name: 'rename_session', description: "Name a session. The name is set on the session itself, not only in this list.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session: the NUMBER from get_sessions ('3'), or the repo name if only one session is in that repo." }, name: { type: 'string', description: 'The name, in his words. A few words, no punctuation needed.' } }, required: ['session', 'name'] } },
    { name: 'transfer_session', description: "Move a session to the other machine with its whole conversation, closing it where it is. Works even when the machine holding it is asleep.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "Which session: the NUMBER from get_sessions ('3'), or the repo name if only one session is in that repo ('status-hub'). Call get_sessions first if you are not sure which he means — an ambiguous name is answered with the choices, not a guess." }, machine: { type: 'string', enum: ['pi', 'mac'], description: 'Where it should end up.' } }, required: ['session', 'machine'] } },
    { name: 'resume_session', description: "Bring a parked session back with its full context.", inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "The NUMBER from get_sessions, or the repo name if only one session is in that repo." }, prompt: { type: 'string', description: 'Optional follow-up to send once it is back.' } }, required: ['session'] } },
    { name: 'end_session', description: 'Close a running session for good. Use when he says he is done with one.', inputSchema: { type: 'object' as const, properties: { session: { type: 'string', description: "The NUMBER from get_sessions, or the repo name if only one session is in that repo." } }, required: ['session'] } },
    { name: 'publish_report', description: "Publish an HTML write-up of work just finished, as well as replying normally — Jared reads it on his phone. Send a body fragment with RAW tags (no <html>/<head>/<body>, and never escaped entities, which render as visible source). Design for a 390px portrait column: short paragraphs, 2-3 column tables, every <svg> given a viewBox and width=\"100%\" rather than fixed pixels. A Content-Security-Policy blocks all JavaScript and external stylesheets, so charts must be inline <svg>; inline <style> and data:/https: images do work.", inputSchema: { type: 'object' as const, properties: { title: { type: 'string', description: "Short page title, e.g. \"Widget freshness fix\". Shown as the notification title." }, summary: { type: 'string', description: "One sentence saying what you did. This becomes the notification body, so it must stand alone on a lock screen." }, html: { type: 'string', description: "The report body as HTML. Inline SVG for visuals; no scripts." } }, required: ['title', 'summary', 'html'] } },
    { name: 'delete_list', description: "Delete an ENTIRE list and everything on it (e.g. 'delete my packing list', 'get rid of the hardware list'). Removes the list and all its items. Matches the list name case-insensitively.", inputSchema: { type: 'object' as const, properties: { list: { type: 'string', description: "List name to delete, e.g. 'groceries'." } }, required: ['list'] } },
    { name: 'delete_note', description: "Delete a note (e.g. 'delete the packing note', 'remove that note'). Matches the note name case-insensitively.", inputSchema: { type: 'object' as const, properties: { name: { type: 'string', description: 'Note name to delete.' } }, required: ['name'] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args || {};

  function text(msg: string) {
    return { content: [{ type: 'text' as const, text: msg }] };
  }

  try {
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
      return text(days.map(d => `${d.date}  ${workouts.categoryLabel(d.categories)}  ${d.setCount} sets  (${d.exercises.join(', ')})`).join('\n'));
    }
    if (name === 'get_workout') {
      return text(await workouts.formatDay((a.date as string || '').trim() || undefined));
    }
    if (name === 'get_exercise_history') {
      const hist = await workouts.getExerciseHistory((a.name as string).trim(), (a.limit as number) || 60);
      if (!hist.length) return text(`No history found for '${a.name}'.`);
      const lines = [`History for ${a.name} (${hist.length} days):`];
      for (const h of hist) lines.push(`  ${h.date}: ${h.sets.map(s => `${s.weight_lbs}x${s.reps}`).join(', ')}`);
      return text(lines.join('\n'));
    }
    if (name === 'update_set') {
      const r = await workouts.updateSet(a.id as number, a as { exercise_id?: number; weight_lbs?: number; reps?: number; occurred_at?: string });
      if (!r) return text(`Set not found: ${a.id}`);
      return text(await workouts.formatDay(r.occurred_at.slice(0, 10)));
    }
    if (name === 'remove_set') {
      const r = await workouts.removeSet(a.id as number);
      if (!r) return text(`Set not found: ${a.id}`);
      return text(`Removed set ${a.id} (${r.exercise} ${r.weight_lbs}x${r.reps}).\n\n` + await workouts.formatDay(r.occurred_at.slice(0, 10)));
    }
    if (name === 'log_nutrition') {
      const entries = await nutrition.logNutrition(a.items as any[]);
      const day = entries[0]?.date || '';
      const allEntries = await nutrition.getNutrition(day);
      const warns = entries.flatMap((e) => e.warnings || []);
      const warnBlock = warns.length ? '\n\n⚠️ Macro check — these look off, double-check them:\n' + warns.map((w) => `- ${w}`).join('\n') : '';
      return text(nutrition.formatNutritionDay(day, allEntries) + warnBlock);
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
      const warns = staged.flatMap((e) => e.warnings || []);
      const warnBlock = warns.length ? '\n\n⚠️ Macro check — these look off, double-check them:\n' + warns.map((w) => `- ${w}`).join('\n') : '';
      return text(`Staged ${staged.length} meal${staged.length === 1 ? '' : 's'}.\n\n` + nutrition.formatStagedList(await nutrition.getStaged()) + warnBlock);
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
      const entry = await nutrition.editStaged((a.id as string).trim(), { name: a.name as string, nutrition: a.nutrition as any, ingredients: a.ingredients as any });
      if (!entry) return text(`Staged meal not found: ${a.id}`);
      const warnBlock = entry.warnings?.length ? '\n\n⚠️ Macro check — these look off, double-check them:\n' + entry.warnings.map((w) => `- ${w}`).join('\n') : '';
      return text(`Updated staged meal: ${entry.name}\n\n` + nutrition.formatStagedList(await nutrition.getStaged()) + warnBlock);
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
      return text(lists.formatDueItems(await lists.dueItems()));
    }
    if (name === 'get_lists') {
      const names = await lists.availableLists();
      if (!names.length) return text('No lists yet.');
      if (a.list) {
        const want = String(a.list).trim().toLowerCase();
        const match = names.find((n) => n.toLowerCase() === want);   // case-insensitive: 'Grocery' → 'grocery'
        if (match) return text(lists.formatListItems(await lists.listItems(match), match));
        // Requested list doesn't exist in any casing — show the real lists so a name mismatch never
        // reads back as a false "empty".
        const blocks: string[] = [];
        for (const n of names) blocks.push(lists.formatListItems(await lists.listItems(n), n));
        return text(`No list named "${a.list}". Your lists:\n\n` + blocks.join('\n\n'));
      }
      const blocks: string[] = [];
      for (const n of names) blocks.push(lists.formatListItems(await lists.listItems(n), n));
      return text(blocks.join('\n\n'));
    }
    if (name === 'add_to_list') {
      const list = String(a.list || lists.DEFAULT_LIST);
      const item = await lists.addItem(list, String(a.text), {
        title: a.title ? String(a.title) : undefined,
        due: a.due ? String(a.due) : undefined,
        repeat_every: a.repeat_every ? String(a.repeat_every) : undefined,
      });
      const when = item.due
        ? ` — due ${item.due}${item.repeat_every ? `, repeating every ${item.repeat_every}` : ''}`
        : '';
      return text(`Added to **${item.list_name}**: ${lists.itemLabel(item)}${when}\n\n`
        + lists.formatListItems(await lists.listItems(item.list_name), item.list_name));
    }
    if (name === 'set_due') {
      const where = a.list ? String(a.list) : null;
      // Only forward the fields the caller actually named — setDue leaves anything absent untouched,
      // so re-dating an item doesn't quietly cancel its recurrence and vice versa.
      const patch: { due?: string | null; repeat_every?: string | null } = {};
      if ('due' in a) patch.due = a.due ? String(a.due) : null;
      if ('repeat_every' in a) patch.repeat_every = a.repeat_every ? String(a.repeat_every) : null;
      const it = await lists.setDue(where, String(a.id), patch);
      if (!it) return text(`No item matched id '${a.id}'${where ? ` on '${where}'` : ''}.`);
      if (!it.due) return text(`**${lists.itemLabel(it)}** (${it.list_name}) no longer has a due date, so it will not fire.`);
      const rep = it.repeat_every ? `, repeating every ${it.repeat_every}` : '';
      return text(`**${lists.itemLabel(it)}** (${it.list_name}) is now due ${it.due}${rep}.`);
    }
    if (name === 'get_notes') {
      if (a.name) {
        const note = await notes.getNote(String(a.name));
        if (!note) { const nn = await notes.availableNotes(); return text(`No note named '${a.name}'.` + (nn.length ? ` Available: ${nn.join(', ')}` : '')); }
        return text(`**${note.name}**\n${note.content}`);
      }
      const nn = await notes.availableNotes();
      return text(nn.length ? `Notes: ${nn.join(', ')}` : 'No notes yet.');
    }
    if (name === 'create_note') {
      await notes.setNote(String(a.name), String(a.content));
      return text(`Saved note '${a.name}'.`);
    }
    if (name === 'remove_from_list') {
      const where = a.list ? String(a.list) : null;
      const it = await lists.removeItem(where, String(a.id));
      if (!it) return text(`No matching item for id '${a.id}'${where ? ` in '${where}'` : ''}.`);
      return text(`Removed from **${it.list_name}**: ${lists.itemLabel(it)}\n\n`
        + lists.formatListItems(await lists.listItems(it.list_name), it.list_name));
    }
    if (name === 'set_list_emoji') {
      const hit = await lists.setListEmoji(String(a.list), a.emoji ? String(a.emoji) : null);
      if (!hit) return text(`No list named '${a.list}'.`);
      return text(a.emoji ? `**${hit}** is now ${a.emoji}.` : `Removed the emoji from **${hit}**.`);
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
      const r = await desk.startSession(a.repo ? String(a.repo) : undefined, String(a.prompt || ''), machine as desk.Machine, a.report === true, a.label ? String(a.label) : undefined);
      if (!r.ok) return text(r.error);
      const where = r.repo === 'root' ? 'the home directory' : `**${r.repo}**`;
      return text(`Started a session in ${where} on the ${r.machine === 'mac' ? 'Mac' : 'Pi'}. It runs on its own; check back with get_sessions.`);
    }
    if (name === 'follow_up') {
      const r = await desk.followUp(String(a.prompt || ''));
      return text(r.ok ? `Sent that to the ${r.repo} session.` : r.error);
    }
    if (name === 'get_sessions') {
      return text(desk.formatSessions(await desk.listSessions(), await desk.queued()));
    }
    if (name === 'set_wall') {
      const raw = String(a.mode || '').toLowerCase();
      const mode = (raw === 'sessions' || raw === 'calendar' ? raw : 'standard') as 'standard' | 'sessions' | 'calendar';
      const months = Number(a.months);
      const r = await desk.setWall(mode, Number.isInteger(months) && months >= 1 && months <= 12 ? months : undefined);
      return text(r.ok ? `TV switched to the ${mode === 'sessions' ? 'session' : mode} wall.` : r.error);
    }
    if (name === 'focus_session') {
      const r = await desk.focusSession(String(a.session || ''));
      if (!r.ok) return text(r.error);
      return text(`Focused ${r.label || r.repo}. What he says next goes there until something else is dispatched or focused.`);
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
      return text(r.ok ? 'Resuming that session with its full context.' : r.error);
    }
    if (name === 'end_session') {
      const r = await desk.sessionCommand('end_session', String(a.session));
      return text(r.ok ? 'Closing that session.' : r.error);
    }
    if (name === 'delete_list') {
      const deleted = await lists.removeList(String(a.list));
      if (!deleted) return text(`No list named '${a.list}'.`);
      return text(`Deleted the '${deleted}' list and all its items.`);
    }
    if (name === 'delete_note') {
      const deleted = await notes.deleteNote(String(a.name));
      if (!deleted) { const nn = await notes.availableNotes(); return text(`No note named '${a.name}'.` + (nn.length ? ` Available: ${nn.join(', ')}` : '')); }
      return text(`Deleted note '${deleted}'.`);
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
