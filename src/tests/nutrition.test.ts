import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../db.js';
import { logNutrition } from '../nutrition.js';
import { getRecipe, saveRecipe } from '../recipes.js';

function withTempDb(fn: (db: ReturnType<typeof openDb>) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-layer-test-'));
  const dbPath = path.join(dir, 'test.sqlite3');
  const db = openDb(dbPath);
  try {
    fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('logNutrition derives calories for manual entries when omitted', () => {
  withTempDb((db) => {
    const [entry] = logNutrition(db, [
      {
        name: 'Apple cinnamon rice cake',
        nutrition: { protein_g: 1, carbs_g: 11, fat_g: 0 },
      },
    ]);

    assert.equal(entry.calories, 48);
    assert.equal(entry.protein_g, 1);
    assert.equal(entry.carbs_g, 11);
    assert.equal(entry.fat_g, 0);
  });
});

test('logNutrition rejects manual entries with missing macros', () => {
  withTempDb((db) => {
    assert.throws(
      () => logNutrition(db, [{ name: 'Broken entry', nutrition: { calories: 50, carbs_g: 11 } }]),
      /requires numeric protein_g and fat_g/i,
    );
  });
});

test('saveRecipe derives calories and recipe-based nutrition logging scales complete macros', () => {
  withTempDb((db) => {
    saveRecipe(db, {
      name: 'Half Block Raw Tofu',
      ingredients: [{ item: 'Firm tofu', quantity: 0.5, unit: 'block' }],
      steps: ['Portion half of the block.'],
      nutrition: { protein_g: 35, carbs_g: 5, fat_g: 17.5 },
    });

    const recipe = getRecipe(db, 'Half Block Raw Tofu');
    assert.equal(recipe?.nutrition?.calories, 318);
    assert.equal(recipe?.nutrition?.protein_g, 35);
    assert.equal(recipe?.nutrition?.carbs_g, 5);
    assert.equal(recipe?.nutrition?.fat_g, 17.5);

    const [entry] = logNutrition(db, [{ recipe: 'Half Block Raw Tofu', servings: 0.5 }]);
    assert.equal(entry.calories, 159);
    assert.equal(entry.protein_g, 17.5);
    assert.equal(entry.carbs_g, 2.5);
    assert.equal(entry.fat_g, 8.8);
  });
});
