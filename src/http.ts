#!/usr/bin/env node
/**
 * HTTP API server for data operations.
 * Runs alongside the MCP server — this is what the Mac calls.
 * Default port: 27186 (configurable via DATA_HTTP_PORT env var).
 */

import http from 'node:http';
import { getDb } from './db.js';
import * as lists from './lists.js';
import * as reminders from './reminders.js';
import * as notes from './notes.js';
import * as health from './health.js';
import * as workouts from './workouts.js';
import * as recipes from './recipes.js';
import * as nutrition from './nutrition.js';
import * as reviews from './reviews.js';

const PORT = Number(process.env.DATA_HTTP_PORT || 27186);

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function json(res: http.ServerResponse, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function notFound(res: http.ServerResponse) {
  json(res, { error: 'not found' }, 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  const method = req.method || 'GET';
  const path = url.pathname;
  const db = getDb();

  try {
    // ── Lists ──
    if (path === '/data/lists' && method === 'GET') {
      return json(res, { lists: lists.availableLists(db) });
    }
    if (path === '/data/lists' && method === 'POST') {
      const body = await parseBody(req);
      const created = lists.createList(db, body.name?.trim().toLowerCase().replace(/ /g, '-'));
      return json(res, { ok: created });
    }
    const listItemsMatch = path.match(/^\/data\/lists\/([^/]+)\/items$/);
    if (listItemsMatch && method === 'GET') {
      const items = lists.listItems(db, listItemsMatch[1]);
      return json(res, { items });
    }
    if (listItemsMatch && method === 'POST') {
      const body = await parseBody(req);
      const item = lists.addItem(db, listItemsMatch[1], body.text);
      return json(res, { item });
    }
    const listItemActionMatch = path.match(/^\/data\/lists\/([^/]+)\/items\/([^/]+)\/(check|uncheck)$/);
    if (listItemActionMatch && method === 'PATCH') {
      const [, listName, id, action] = listItemActionMatch;
      const item = action === 'check'
        ? lists.checkItem(db, listName, id)
        : lists.uncheckItem(db, listName, id);
      if (!item) return json(res, { error: 'not found' }, 404);
      return json(res, { item });
    }
    const listItemDeleteMatch = path.match(/^\/data\/lists\/([^/]+)\/items\/([^/]+)$/);
    if (listItemDeleteMatch && method === 'DELETE') {
      const item = lists.removeItem(db, listItemDeleteMatch[1], listItemDeleteMatch[2]);
      if (!item) return json(res, { error: 'not found' }, 404);
      return json(res, { item });
    }

    // ── Reminders ──
    if (path === '/data/reminders' && method === 'GET') {
      return json(res, { reminders: reminders.listReminders(db) });
    }
    if (path === '/data/reminders' && method === 'POST') {
      const body = await parseBody(req);
      const r = reminders.addReminder(db, body.text, body.due);
      return json(res, { reminder: r });
    }
    const reminderCompleteMatch = path.match(/^\/data\/reminders\/([^/]+)\/complete$/);
    if (reminderCompleteMatch && method === 'PATCH') {
      const r = reminders.completeReminder(db, reminderCompleteMatch[1]);
      if (!r) return json(res, { error: 'not found' }, 404);
      return json(res, { reminder: r });
    }
    const reminderDeleteMatch = path.match(/^\/data\/reminders\/([^/]+)$/);
    if (reminderDeleteMatch && method === 'DELETE') {
      const r = reminders.removeReminder(db, reminderDeleteMatch[1]);
      if (!r) return json(res, { error: 'not found' }, 404);
      return json(res, { reminder: r });
    }

    // ── Notes ──
    if (path === '/data/notes' && method === 'GET') {
      return json(res, { notes: notes.availableNotes(db) });
    }
    const noteMatch = path.match(/^\/data\/notes\/([^/]+)$/);
    if (noteMatch && method === 'GET') {
      const note = notes.getNote(db, noteMatch[1]);
      if (!note) return json(res, { error: 'not found' }, 404);
      return json(res, { note });
    }
    if (noteMatch && method === 'PUT') {
      const body = await parseBody(req);
      notes.setNote(db, noteMatch[1], body.content);
      return json(res, { ok: true });
    }

    // ── Health ──
    if (path === '/data/health/profile' && method === 'GET') {
      const profile = health.getProfile(db);
      const weights = health.recentWeights(db);
      const targets = health.recentTargets(db);
      return json(res, { profile, weights, targets });
    }
    if (path === '/data/health/height' && method === 'PUT') {
      const body = await parseBody(req);
      health.setHeight(db, body.height_in);
      return json(res, { ok: true });
    }
    if (path === '/data/health/weight' && method === 'POST') {
      const body = await parseBody(req);
      const entry = health.logWeight(db, body.weight_lbs, body.date);
      return json(res, { entry });
    }
    if (path === '/data/health/targets' && method === 'POST') {
      const body = await parseBody(req);
      const entry = health.setNutritionTargets(db, {
        calories: body.calories,
        protein_g: body.protein_g,
        carbs_g: body.carbs_g,
        fat_g: body.fat_g,
      }, body.date);
      return json(res, { entry });
    }
    if (path === '/data/health/targets' && method === 'GET') {
      const targets = health.recentTargets(db);
      return json(res, { targets });
    }

    // ── Workouts ──
    if (path === '/data/workouts/catalog' && method === 'GET') {
      return json(res, workouts.getCatalog(db));
    }
    if (path === '/data/workouts' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 10;
      return json(res, { workouts: workouts.listWorkouts(db, limit) });
    }
    if (path === '/data/workouts' && method === 'POST') {
      const body = await parseBody(req);
      const session = workouts.startWorkout(db, body.type, body.notes);
      return json(res, { session });
    }
    const workoutMatch = path.match(/^\/data\/workouts\/([^/]+)$/);
    if (workoutMatch && method === 'GET') {
      const session = workouts.getWorkout(db, workoutMatch[1]);
      if (!session) return json(res, { error: 'not found' }, 404);
      return json(res, { session });
    }
    if (workoutMatch && method === 'DELETE') {
      const session = workouts.deleteWorkout(db, workoutMatch[1]);
      if (!session) return json(res, { error: 'not found' }, 404);
      return json(res, { deleted: session });
    }
    const workoutNotesMatch = path.match(/^\/data\/workouts\/([^/]+)\/notes$/);
    if (workoutNotesMatch && method === 'PATCH') {
      const body = await parseBody(req);
      const session = workouts.updateSessionNotes(db, workoutNotesMatch[1], body.notes);
      if (!session) return json(res, { error: 'not found' }, 404);
      return json(res, { session });
    }
    const workoutExercisesMatch = path.match(/^\/data\/workouts\/([^/]+)\/exercises$/);
    if (workoutExercisesMatch && method === 'POST') {
      const body = await parseBody(req);
      const session = workouts.logExercise(db, workoutExercisesMatch[1], body.exercises);
      if (!session) return json(res, { error: 'not found' }, 404);
      return json(res, { session });
    }
    const exerciseSetsMatch = path.match(/^\/data\/workouts\/([^/]+)\/exercises\/([^/]+)\/sets$/);
    if (exerciseSetsMatch && method === 'PUT') {
      const body = await parseBody(req);
      const session = workouts.updateExercise(db, exerciseSetsMatch[1], decodeURIComponent(exerciseSetsMatch[2]), body.sets);
      if (!session) return json(res, { error: 'not found' }, 404);
      return json(res, { session });
    }
    if (exerciseSetsMatch && method === 'POST') {
      const body = await parseBody(req);
      const session = workouts.addSet(db, exerciseSetsMatch[1], decodeURIComponent(exerciseSetsMatch[2]), body.weight_lbs, body.reps);
      if (!session) return json(res, { error: 'not found' }, 404);
      return json(res, { session });
    }
    const exerciseDeleteMatch = path.match(/^\/data\/workouts\/([^/]+)\/exercises\/([^/]+)$/);
    if (exerciseDeleteMatch && method === 'DELETE') {
      const result = workouts.removeExercise(db, exerciseDeleteMatch[1], decodeURIComponent(exerciseDeleteMatch[2]));
      if (!result) return json(res, { error: 'not found' }, 404);
      return json(res, { removed: result.removed, session: result.session });
    }
    const exerciseHistoryMatch = path.match(/^\/data\/exercises\/([^/]+)\/history$/);
    if (exerciseHistoryMatch && method === 'GET') {
      const limit = Number(url.searchParams.get('limit')) || 20;
      const history = workouts.getExerciseHistory(db, decodeURIComponent(exerciseHistoryMatch[1]), limit);
      return json(res, { history });
    }

    // ── Recipes ──
    if (path === '/data/recipes' && method === 'GET') {
      const tag = url.searchParams.get('tag') || undefined;
      return json(res, { recipes: recipes.listRecipes(db, tag) });
    }
    const recipeMatch = path.match(/^\/data\/recipes\/([^/]+)$/);
    if (recipeMatch && method === 'GET') {
      const r = recipes.getRecipe(db, decodeURIComponent(recipeMatch[1]));
      if (!r) return json(res, { error: 'not found' }, 404);
      return json(res, { recipe: r });
    }
    if (recipeMatch && method === 'PUT') {
      const body = await parseBody(req);
      body.name = decodeURIComponent(recipeMatch[1]);
      const result = recipes.saveRecipe(db, body);
      return json(res, { recipe: result.recipe, action: result.action });
    }
    if (recipeMatch && method === 'DELETE') {
      const r = recipes.deleteRecipe(db, decodeURIComponent(recipeMatch[1]));
      if (!r) return json(res, { error: 'not found' }, 404);
      return json(res, { deleted: r });
    }

    // ── Nutrition ──
    if (path === '/data/nutrition' && method === 'GET') {
      const date = url.searchParams.get('date') || undefined;
      const entries = nutrition.getNutrition(db, date);
      return json(res, { entries });
    }
    if (path === '/data/nutrition' && method === 'POST') {
      const body = await parseBody(req);
      const entries = nutrition.logNutrition(db, body.items);
      return json(res, { entries });
    }
    const nutritionDeleteMatch = path.match(/^\/data\/nutrition\/([^/]+)$/);
    if (nutritionDeleteMatch && method === 'DELETE') {
      const entry = nutrition.deleteNutritionEntry(db, nutritionDeleteMatch[1]);
      if (!entry) return json(res, { error: 'not found' }, 404);
      return json(res, { deleted: entry });
    }

    // ── Reviews ──
    if (path === '/data/reviews/notes' && method === 'GET') {
      return json(res, { text: reviews.buildNotesReview(db) });
    }
    const reviewListMatch = path.match(/^\/data\/reviews\/lists(?:\/([^/]+))?$/);
    if (reviewListMatch && method === 'GET') {
      return json(res, { text: reviews.buildListReview(db, reviewListMatch[1]) });
    }
    if (path === '/data/reviews/reminders' && method === 'GET') {
      return json(res, { text: reviews.buildRemindersReview(db) });
    }

    // Status
    if (path === '/data/status' && method === 'GET') {
      return json(res, { ok: true, version: '2.0.0' });
    }

    notFound(res);
  } catch (err: any) {
    console.error('HTTP error:', err.message);
    json(res, { error: err.message }, 500);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[data-http] listening on :${PORT}`);
});
