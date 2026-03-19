#!/usr/bin/env node
/**
 * MCP server for personal data — drop-in Node replacement for the Python mcp-data.
 * Same tool names, same schemas, same output formatting.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getDb } from './db.js';
import * as lists from './lists.js';
import * as reminders from './reminders.js';
import * as notes from './notes.js';
import * as health from './health.js';
import * as workouts from './workouts.js';
import * as recipes from './recipes.js';
import * as nutrition from './nutrition.js';
import * as reviews from './reviews.js';

const server = new Server({ name: 'data', version: '2.0.0' }, { capabilities: { tools: {} } });

// ── Tool definitions ──────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // Lists
    {
      name: 'list_items',
      description: "View all active (non-deleted) items on a list. Available lists: todo, grocery, or any custom list. Use this to check what's on a list before adding/removing.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          list_name: { type: 'string', description: "Name of the list (e.g. 'todo', 'grocery'). Omit to see all lists." },
        },
      },
    },
    {
      name: 'add_item',
      description: "Add an item to a list (todo, grocery, or any custom list). Creates the list if it doesn't exist. Use for adding to-do items, grocery items, or any list-based data.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          list_name: { type: 'string', description: "Name of the list (e.g. 'todo', 'grocery')." },
          text: { type: 'string', description: 'The item text to add.' },
        },
        required: ['list_name', 'text'],
      },
    },
    {
      name: 'check_item',
      description: 'Mark a list item as done/checked. Use the short ID prefix shown in list_items output.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          list_name: { type: 'string', description: 'Name of the list.' },
          id: { type: 'string', description: 'ID (or prefix) of the item to check.' },
        },
        required: ['list_name', 'id'],
      },
    },
    {
      name: 'uncheck_item',
      description: 'Mark a list item as not done/unchecked.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          list_name: { type: 'string', description: 'Name of the list.' },
          id: { type: 'string', description: 'ID (or prefix) of the item to uncheck.' },
        },
        required: ['list_name', 'id'],
      },
    },
    {
      name: 'remove_item',
      description: 'Remove (soft-delete) an item from a list.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          list_name: { type: 'string', description: 'Name of the list.' },
          id: { type: 'string', description: 'ID (or prefix) of the item to remove.' },
        },
        required: ['list_name', 'id'],
      },
    },
    {
      name: 'create_list',
      description: 'Create a new empty list.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          list_name: { type: 'string', description: 'Name for the new list (lowercase, no spaces — use hyphens).' },
        },
        required: ['list_name'],
      },
    },
    // Reminders
    {
      name: 'list_reminders',
      description: 'View all active reminders with their due dates and IDs.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'add_reminder',
      description: 'Add a new reminder with an optional due date/time.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          text: { type: 'string', description: 'The reminder text.' },
          due: { type: 'string', description: "Optional due date in ISO format (e.g. '2026-03-01T09:00:00')." },
        },
        required: ['text'],
      },
    },
    {
      name: 'complete_reminder',
      description: 'Mark a reminder as done/completed.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'ID (or prefix) of the reminder to complete.' },
        },
        required: ['id'],
      },
    },
    {
      name: 'remove_reminder',
      description: 'Remove (soft-delete) a reminder.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'ID (or prefix) of the reminder to remove.' },
        },
        required: ['id'],
      },
    },
    // Notes
    {
      name: 'get_note',
      description: 'Read a note by name. Omit name to list available notes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: "Note name (e.g. 'general'). Omit to list available notes." },
        },
      },
    },
    {
      name: 'set_note',
      description: "Write or update a note. Creates the note if it doesn't exist.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: "Note name (e.g. 'general')." },
          content: { type: 'string', description: 'The content to write to the note.' },
        },
        required: ['name', 'content'],
      },
    },
    // Reviews
    {
      name: 'review_notes',
      description: "Pull all notes for review. Returns every note with built-in instructions for how to present them to the user. Use when the user says 'review my notes' or during scheduled reviews.",
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'review_list',
      description: "Pull a list for review with built-in handling instructions. Use when the user says 'review my grocery list', 'review my todo list', etc. Omit list_name to review ALL lists.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          list_name: { type: 'string', description: "Name of the list to review (e.g. 'todo', 'grocery'). Omit to review all lists." },
        },
      },
    },
    {
      name: 'review_reminders',
      description: "Pull all reminders for review with built-in handling instructions. Use when the user says 'review my reminders' or during scheduled reviews.",
      inputSchema: { type: 'object' as const, properties: {} },
    },
    // Health
    {
      name: 'get_health_profile',
      description: 'Returns height, recent weight log entries, and current nutrition targets (calories, protein, carbs, fat).',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'set_height',
      description: 'Set or update height in inches.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          height_in: { type: 'number', description: 'Height in inches (e.g. 72 for 6\'0").' },
        },
        required: ['height_in'],
      },
    },
    {
      name: 'log_weight',
      description: 'Log a body weight entry. Appends to the weight log.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          weight_lbs: { type: 'number', description: 'Body weight in pounds.' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
        },
        required: ['weight_lbs'],
      },
    },
    {
      name: 'get_nutrition_targets',
      description: 'Get the current daily nutrition targets (calories, protein, carbs, fat) and recent target history.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'set_nutrition_targets',
      description: 'Set daily nutrition targets (calories, protein, carbs, fat). Appends a new entry to the target log so history is preserved. The most recent entry becomes the current target, shown in get_health_profile.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          calories: { type: 'number', description: 'Daily calorie target.' },
          protein_g: { type: 'number', description: 'Daily protein target in grams.' },
          carbs_g: { type: 'number', description: 'Daily carbs target in grams.' },
          fat_g: { type: 'number', description: 'Daily fat target in grams.' },
          date: { type: 'string', description: 'Date these targets take effect (YYYY-MM-DD). Defaults to today.' },
        },
        required: ['calories', 'protein_g', 'carbs_g', 'fat_g'],
      },
    },
    // Workout catalog
    {
      name: 'get_workout_catalog',
      description: 'Returns all unique exercise names and session types seen so far. Call this before start_workout or log_exercise to see existing session types and exercise names. Always reuse an exact existing name when the exercise is the same, even if the user phrases it differently.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    // Workouts
    {
      name: 'start_workout',
      description: "Start a new workout session. Returns a session ID. Call get_workout_catalog first to reuse an existing session type.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          type: { type: 'string', description: "Workout type (e.g. 'push', 'pull', 'legs'). Check catalog for existing types." },
          notes: { type: 'string', description: 'Optional notes for this session.' },
        },
        required: ['type'],
      },
    },
    {
      name: 'log_exercise',
      description: "Log one or more exercises to a workout session in a single call. Pass an 'exercises' array (preferred) to log multiple at once. Check get_workout_catalog first to match existing exercise names for consistency. For dumbbell exercises, weight_lbs is the TOTAL weight lifted — if the user says '30 lb dumbbells', log 60 lbs (both dumbbells combined). For bodyweight exercises, use weight_lbs=0. Returns a pre-formatted workout table. Pass it to the user exactly as-is — do not reformat or summarize.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID or 8-char prefix from start_workout.' },
          exercises: {
            type: 'array',
            description: 'List of exercises to log: [{name, sets: [{weight_lbs, reps}]}].',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                sets: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { weight_lbs: { type: 'number' }, reps: { type: 'integer' } },
                    required: ['weight_lbs', 'reps'],
                  },
                },
              },
              required: ['name', 'sets'],
            },
          },
        },
        required: ['session_id', 'exercises'],
      },
    },
    {
      name: 'list_workouts',
      description: 'List recent workout sessions (summarized, no set detail).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'integer', description: 'Max sessions to return. Defaults to 10.' },
        },
      },
    },
    {
      name: 'get_workout',
      description: 'Get full detail of a workout session including all exercises and sets.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID or 8-char prefix.' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'get_exercise_history',
      description: 'Get progression history for a single exercise across all sessions.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Exercise name (exact match, case-insensitive).' },
          limit: { type: 'integer', description: 'Max sessions to return. Defaults to 20.' },
        },
        required: ['name'],
      },
    },
    {
      name: 'update_exercise',
      description: "Update an exercise's sets in a workout session. Finds the exercise by name (case-insensitive) and replaces its sets. Returns a pre-formatted workout table. Pass it to the user exactly as-is — do not reformat or summarize.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID or 8-char prefix.' },
          name: { type: 'string', description: 'Exercise name (case-insensitive match).' },
          sets: {
            type: 'array',
            description: 'New sets to replace existing: [{weight_lbs, reps}].',
            items: {
              type: 'object',
              properties: { weight_lbs: { type: 'number' }, reps: { type: 'integer' } },
              required: ['weight_lbs', 'reps'],
            },
          },
        },
        required: ['session_id', 'name', 'sets'],
      },
    },
    {
      name: 'add_set',
      description: "Append a single set to an existing exercise in a workout session. If the exercise doesn't exist yet, creates it. For dumbbell exercises, weight_lbs is the TOTAL weight — if the user says '30 lb dumbbells', log 60 lbs. For bodyweight, use weight_lbs=0. Returns a pre-formatted workout table. Pass it to the user exactly as-is — do not reformat or summarize.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID or 8-char prefix.' },
          name: { type: 'string', description: 'Exercise name (case-insensitive match).' },
          weight_lbs: { type: 'number', description: 'Weight in lbs (use 0 for bodyweight).' },
          reps: { type: 'integer', description: 'Number of reps.' },
        },
        required: ['session_id', 'name', 'weight_lbs', 'reps'],
      },
    },
    {
      name: 'remove_exercise',
      description: 'Remove an exercise from a workout session by name (case-insensitive). Returns a pre-formatted workout table. Pass it to the user exactly as-is — do not reformat or summarize.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID or 8-char prefix.' },
          name: { type: 'string', description: 'Exercise name (case-insensitive match).' },
        },
        required: ['session_id', 'name'],
      },
    },
    {
      name: 'delete_workout',
      description: 'Permanently delete a workout session.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID or 8-char prefix.' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'update_session_notes',
      description: 'Set or overwrite the notes field on a workout session. Pass an empty string to clear notes. Returns a pre-formatted workout table. Pass it to the user exactly as-is — do not reformat or summarize.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          session_id: { type: 'string', description: 'Session ID or 8-char prefix.' },
          notes: { type: 'string', description: 'Notes text to set. Overwrites any existing notes.' },
        },
        required: ['session_id', 'notes'],
      },
    },
    // Recipes
    {
      name: 'list_recipes',
      description: 'List all saved recipes. Optionally filter by tag. Returns recipe names and tags.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          tag: { type: 'string', description: "Optional tag to filter by (e.g. 'breakfast', 'high-protein')." },
        },
      },
    },
    {
      name: 'get_recipe',
      description: 'Get the full details of a recipe by name (case-insensitive match).',
      inputSchema: {
        type: 'object' as const,
        properties: { name: { type: 'string', description: 'Recipe name.' } },
        required: ['name'],
      },
    },
    {
      name: 'save_recipe',
      description: "Create or update a recipe. If a recipe with the same name exists, it is overwritten. ingredients is a list of objects with fields: item (required), quantity (number, optional), unit (optional), notes (optional). steps is a list of instruction strings. tags is an optional list of strings (e.g. ['breakfast', 'high-protein']). nutrition is REQUIRED: {calories, protein_g, carbs_g, fat_g}. Each recipe represents one serving. Use your knowledge to fill in accurate nutrition values; look them up if unsure. Never omit or approximate as zero unless the food genuinely has none.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Recipe name.' },
          ingredients: {
            type: 'array', description: 'List of ingredients.',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string' }, quantity: { type: 'number' },
                unit: { type: 'string' }, notes: { type: 'string' },
              },
              required: ['item'],
            },
          },
          steps: { type: 'array', items: { type: 'string' }, description: 'Step-by-step instructions.' },
          notes: { type: 'string', description: 'Optional recipe-level notes.' },
          tags: { type: 'array', items: { type: 'string' }, description: "Optional tags for filtering (e.g. ['breakfast', 'high-protein'])." },
          nutrition: {
            type: 'object', description: 'Required nutrition info per serving.',
            properties: {
              calories: { type: 'number' }, protein_g: { type: 'number' },
              carbs_g: { type: 'number' }, fat_g: { type: 'number' },
            },
            required: ['calories', 'protein_g', 'carbs_g', 'fat_g'],
          },
        },
        required: ['name', 'ingredients', 'steps', 'nutrition'],
      },
    },
    {
      name: 'delete_recipe',
      description: 'Permanently delete a recipe by name (case-insensitive).',
      inputSchema: {
        type: 'object' as const,
        properties: { name: { type: 'string', description: 'Recipe name.' } },
        required: ['name'],
      },
    },
    // Nutrition
    {
      name: 'log_nutrition',
      description: "Log food eaten for a given date. Each entry has a name and optional quantity multiplier (default 1.0 = one full serving). If the food matches a saved recipe, pull nutrition from it and scale by quantity. For standalone foods (no recipe), include the nutrition values directly. Always confirm what was logged by passing the result to the user as-is.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today if omitted.' },
          items: {
            type: 'array', description: 'List of food items eaten.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Food or recipe name.' },
                quantity: { type: 'number', description: 'Serving multiplier (default 1.0).' },
                recipe: { type: 'string', description: 'Exact recipe name if this references a saved recipe.' },
                nutrition: {
                  type: 'object', description: 'Required if not a saved recipe.',
                  properties: {
                    calories: { type: 'number' }, protein_g: { type: 'number' },
                    carbs_g: { type: 'number' }, fat_g: { type: 'number' },
                  },
                },
              },
              required: ['name'],
            },
          },
        },
        required: ['items'],
      },
    },
    {
      name: 'get_nutrition',
      description: 'Get the nutrition log for a given date, including a daily totals summary.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format. Defaults to today.' },
        },
      },
    },
    {
      name: 'delete_nutrition_entry',
      description: 'Remove a specific entry from the nutrition log by its ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          id: { type: 'string', description: 'Entry ID or 8-char prefix.' },
        },
        required: ['id'],
      },
    },
  ],
}));

// ── Tool handler ──────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args || {};
  const db = getDb();

  function text(msg: string) {
    return { content: [{ type: 'text' as const, text: msg }] };
  }

  // Lists
  if (name === 'list_items') {
    const listName = (a.list_name as string || '').trim();
    if (!listName) {
      const available = lists.availableLists(db);
      return text(available.length ? 'Available lists: ' + available.join(', ') : 'No lists found.');
    }
    return text(lists.formatListItems(lists.listItems(db, listName), listName));
  }
  if (name === 'add_item') {
    const item = lists.addItem(db, (a.list_name as string).trim(), (a.text as string).trim());
    return text(`Added '${item.text}' to ${a.list_name}. [id: ${item.id.slice(0, 8)}]`);
  }
  if (name === 'check_item') {
    const item = lists.checkItem(db, (a.list_name as string).trim(), (a.id as string).trim());
    return text(item ? `Checked: ${item.text}` : `Item not found: ${a.id}`);
  }
  if (name === 'uncheck_item') {
    const item = lists.uncheckItem(db, (a.list_name as string).trim(), (a.id as string).trim());
    return text(item ? `Unchecked: ${item.text}` : `Item not found: ${a.id}`);
  }
  if (name === 'remove_item') {
    const item = lists.removeItem(db, (a.list_name as string).trim(), (a.id as string).trim());
    return text(item ? `Removed: ${item.text}` : `Item not found: ${a.id}`);
  }
  if (name === 'create_list') {
    const n = (a.list_name as string).trim().toLowerCase().replace(/ /g, '-');
    return text(lists.createList(db, n) ? `Created empty list: ${n}` : `List '${n}' already exists.`);
  }

  // Reminders
  if (name === 'list_reminders') {
    return text(reminders.formatReminders(reminders.listReminders(db)));
  }
  if (name === 'add_reminder') {
    const r = reminders.addReminder(db, (a.text as string).trim(), a.due as string | undefined);
    const dueStr = r.due ? ` (due: ${r.due})` : '';
    return text(`Added reminder: '${r.text}'${dueStr} [id: ${r.id.slice(0, 8)}]`);
  }
  if (name === 'complete_reminder') {
    const r = reminders.completeReminder(db, (a.id as string).trim());
    return text(r ? `Completed reminder: ${r.text}` : `Reminder not found: ${a.id}`);
  }
  if (name === 'remove_reminder') {
    const r = reminders.removeReminder(db, (a.id as string).trim());
    return text(r ? `Removed reminder: ${r.text}` : `Reminder not found: ${a.id}`);
  }

  // Notes
  if (name === 'get_note') {
    const noteName = (a.name as string || '').trim();
    if (!noteName) {
      const available = notes.availableNotes(db);
      return text(available.length ? 'Available notes: ' + available.join(', ') : 'No notes found.');
    }
    const note = notes.getNote(db, noteName);
    if (!note) return text(`Note '${noteName}' not found.`);
    if (!note.content) return text(`Note '${noteName}' is empty. (last updated: ${note.updated})`);
    return text(`**${noteName}** (updated: ${note.updated}):\n${note.content}`);
  }
  if (name === 'set_note') {
    const noteName = (a.name as string).trim().toLowerCase().replace(/ /g, '-');
    notes.setNote(db, noteName, a.content as string);
    return text(`Note '${noteName}' saved.`);
  }

  // Reviews
  if (name === 'review_notes') return text(reviews.buildNotesReview(db));
  if (name === 'review_list') return text(reviews.buildListReview(db, (a.list_name as string || '').trim() || undefined));
  if (name === 'review_reminders') return text(reviews.buildRemindersReview(db));

  // Health
  if (name === 'get_health_profile') {
    const profile = health.getProfile(db);
    const weights = health.recentWeights(db);
    const targets = health.recentTargets(db);
    return text(health.formatProfile(profile, weights, targets));
  }
  if (name === 'set_height') {
    health.setHeight(db, a.height_in as number);
    const h = a.height_in as number;
    const feet = Math.floor(h / 12);
    const inches = Math.floor(h % 12);
    return text(`Height set to ${h} in (${feet}'${inches}").`);
  }
  if (name === 'log_weight') {
    const entry = health.logWeight(db, a.weight_lbs as number, a.date as string | undefined);
    return text(`Logged ${entry.weight_lbs} lbs on ${entry.date}.`);
  }
  if (name === 'get_nutrition_targets') {
    const targets = health.recentTargets(db);
    if (!targets.length) return text('No nutrition targets set yet.');
    const t = targets[0];
    const lines = [`Current nutrition targets (as of ${t.date}): ${t.calories} cal, ${t.protein_g}g protein, ${t.carbs_g}g carbs, ${t.fat_g}g fat`];
    if (targets.length > 1) {
      lines.push(`\nTarget history (last ${targets.length}):`);
      for (const e of targets) {
        lines.push(`  ${e.date}: ${e.calories} cal, ${e.protein_g}g P / ${e.carbs_g}g C / ${e.fat_g}g F`);
      }
    }
    return text(lines.join('\n'));
  }
  if (name === 'set_nutrition_targets') {
    const entry = health.setNutritionTargets(db, {
      calories: a.calories as number,
      protein_g: a.protein_g as number,
      carbs_g: a.carbs_g as number,
      fat_g: a.fat_g as number,
    }, a.date as string | undefined);
    return text(`Nutrition targets set (${entry.date}): ${entry.calories} cal, ${entry.protein_g}g protein, ${entry.carbs_g}g carbs, ${entry.fat_g}g fat`);
  }

  // Workout catalog
  if (name === 'get_workout_catalog') {
    const catalog = workouts.getCatalog(db);
    return text(
      `Session types (${catalog.types.length}): ${catalog.types.join(', ') || 'none yet'}\n` +
      `Exercises (${catalog.exercises.length}): ${catalog.exercises.join(', ') || 'none yet'}`
    );
  }

  // Workouts
  if (name === 'start_workout') {
    const session = workouts.startWorkout(db, (a.type as string).trim(), (a.notes as string || '').trim());
    return text(
      `Started ${session.type} workout (${session.date}).\n` +
      `Session ID: ${session.id.slice(0, 8)}\n\n` +
      workouts.formatSessionTable(session)
    );
  }
  if (name === 'log_exercise') {
    const session = workouts.logExercise(db, (a.session_id as string).trim(), a.exercises as any[]);
    if (!session) return text(`Session not found: ${a.session_id}`);
    return text(workouts.formatSessionTable(session));
  }
  if (name === 'list_workouts') {
    const sessions = workouts.listWorkouts(db, (a.limit as number) || 10);
    if (!sessions.length) return text('No workout sessions found.');
    const lines = sessions.map(s =>
      `[${s.id.slice(0, 8)}] ${s.date.slice(0, 10)}  ${s.type}  ${s.exerciseCount} exercises`
    );
    return text(lines.join('\n'));
  }
  if (name === 'get_workout') {
    const session = workouts.getWorkout(db, (a.session_id as string).trim());
    if (!session) return text(`Session not found: ${a.session_id}`);
    return text(workouts.formatWorkoutDetail(session));
  }
  if (name === 'get_exercise_history') {
    const results = workouts.getExerciseHistory(db, (a.name as string).trim(), (a.limit as number) || 20);
    if (!results.length) return text(`No history found for '${a.name}'.`);
    const lines = [`History for ${a.name} (${results.length} sessions):`];
    for (const r of results) {
      const setSummary = r.sets.map(s => `${s.weight_lbs}x${s.reps}`).join(', ');
      lines.push(`  ${r.date} [${r.session_id}] ${r.session_type}: ${setSummary}`);
    }
    return text(lines.join('\n'));
  }
  if (name === 'update_exercise') {
    const session = workouts.updateExercise(db, (a.session_id as string).trim(), (a.name as string).trim(), a.sets as any[]);
    if (!session) return text(`Exercise '${a.name}' not found in session ${(a.session_id as string).slice(0, 8)}.`);
    return text(workouts.formatSessionTable(session));
  }
  if (name === 'add_set') {
    const session = workouts.addSet(db, (a.session_id as string).trim(), (a.name as string).trim(), a.weight_lbs as number, a.reps as number);
    if (!session) return text(`Session not found: ${a.session_id}`);
    return text(workouts.formatSessionTable(session));
  }
  if (name === 'remove_exercise') {
    const result = workouts.removeExercise(db, (a.session_id as string).trim(), (a.name as string).trim());
    if (!result) return text(`Exercise '${a.name}' not found in session ${(a.session_id as string).slice(0, 8)}.`);
    return text(`Removed ${result.removed}.\n\n` + workouts.formatSessionTable(result.session));
  }
  if (name === 'delete_workout') {
    const session = workouts.deleteWorkout(db, (a.session_id as string).trim());
    if (!session) return text(`Session not found: ${a.session_id}`);
    return text(`Deleted session ${session.id.slice(0, 8)} (${session.type} on ${session.date.slice(0, 10)}).`);
  }
  if (name === 'update_session_notes') {
    const session = workouts.updateSessionNotes(db, (a.session_id as string).trim(), (a.notes as string).trim());
    if (!session) return text(`Session not found: ${a.session_id}`);
    return text(workouts.formatSessionTable(session));
  }

  // Recipes
  if (name === 'list_recipes') {
    const recipeList = recipes.listRecipes(db, (a.tag as string || '').trim() || undefined);
    if (!recipeList.length) {
      return text(a.tag ? `No recipes found with tag '${a.tag}'.` : 'No recipes saved yet.');
    }
    const lines = recipeList.map(r => `**${r.name}**` + (r.tags.length ? ` — ${r.tags.join(', ')}` : ''));
    return text(`${recipeList.length} recipe(s):\n\n${lines.join('\n')}`);
  }
  if (name === 'get_recipe') {
    const r = recipes.getRecipe(db, a.name as string);
    if (!r) return text(`Recipe not found: ${a.name}`);
    return text(recipes.formatRecipe(r));
  }
  if (name === 'save_recipe') {
    const result = recipes.saveRecipe(db, a as any);
    return text(`${result.action} recipe: ${result.recipe.name}\n\n` + recipes.formatRecipe(result.recipe));
  }
  if (name === 'delete_recipe') {
    const r = recipes.deleteRecipe(db, a.name as string);
    if (!r) return text(`Recipe not found: ${a.name}`);
    return text(`Deleted recipe: ${r.name}`);
  }

  // Nutrition
  if (name === 'log_nutrition') {
    const entries = nutrition.logNutrition(db, a.items as any[], (a.date as string || '').trim() || undefined);
    const day = entries[0]?.date || (a.date as string) || '';
    const allEntries = nutrition.getNutrition(db, day);
    return text(nutrition.formatNutritionDay(day, allEntries));
  }
  if (name === 'get_nutrition') {
    const day = (a.date as string || '').trim() || undefined;
    const entries = nutrition.getNutrition(db, day);
    return text(nutrition.formatNutritionDay(day || entries[0]?.date || '', entries));
  }
  if (name === 'delete_nutrition_entry') {
    const entry = nutrition.deleteNutritionEntry(db, (a.id as string).trim());
    if (!entry) return text(`Entry not found: ${a.id}`);
    const dayEntries = nutrition.getNutrition(db, entry.date);
    return text(`Deleted: ${entry.name}\n\n` + nutrition.formatNutritionDay(entry.date, dayEntries));
  }

  return text(`Unknown tool: ${name}`);
});

// ── Start ─────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  console.error('MCP server error:', err);
  process.exit(1);
});
