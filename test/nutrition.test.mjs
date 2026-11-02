// The eating day a meal lands on, and the arithmetic of subtracting leftovers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { dateFromOccurredAt, planLeftovers } from '../dist/nutrition.js';
import { normalizeIngredients } from '../dist/ingredients.js';
import { ValidationError } from '../dist/helpers.js';

describe('dateFromOccurredAt (the 4am eating day)', () => {
  test('before 4am counts toward the previous day', () => {
    assert.equal(dateFromOccurredAt('2026-03-10T03:59:00'), '2026-03-09');
    assert.equal(dateFromOccurredAt('2026-03-10T04:00:00'), '2026-03-10');
    assert.equal(dateFromOccurredAt('2026-03-01T01:00'), '2026-02-28');
    assert.equal(dateFromOccurredAt('2026-01-01T00:30:00'), '2025-12-31');
  });

  test('a bare date is that day', () => {
    assert.equal(dateFromOccurredAt('2026-03-10T12:00:00'), '2026-03-10');
  });

  test('holds across a DST change', () => {
    // 2026-11-01 01:30 happens twice in New York and 2026-03-08 02:30 not at all.
    assert.equal(dateFromOccurredAt('2026-11-01T03:30:00'), '2026-10-31');
    assert.equal(dateFromOccurredAt('2026-11-01T05:00:00'), '2026-11-01');
    assert.equal(dateFromOccurredAt('2026-03-08T03:30:00'), '2026-03-07');
    assert.equal(dateFromOccurredAt('2026-03-08T04:30:00'), '2026-03-08');
  });
});

const dish = normalizeIngredients([
  { food: 'chicken breast', amount: 200, unit: 'g', protein_g: 62, carbs_g: 0, fat_g: 7 },
  { food: 'broccoli', amount: 150, unit: 'g', protein_g: 4, carbs_g: 10, fat_g: 1, produce_g: 150, produce_type: 'dark_green_vegetable' },
  { food: 'avocado', amount: 0.5, unit: '', protein_g: 1.4, carbs_g: 6, fat_g: 10.5, produce_g: 70, produce_type: 'fruit' },
], 'dish').ingredients;

describe('planLeftovers', () => {
  test('weighs the dish from gram portions and produce weights, and scales everything by what was eaten', () => {
    const p = planLeftovers(dish, 105, undefined, 'dish');   // 420 g dish, a quarter left
    assert.equal(p.total, 420);
    assert.equal(p.factor, 0.75);
    assert.equal(p.ingredients[0].amount, 150);
    assert.equal(p.ingredients[0].protein_g, 46.5);
    assert.equal(p.ingredients[2].amount, 0.375);
    assert.equal(p.ingredients[2].produce_g, 52.5);
    assert.deepEqual(p.prod, { veg_g: 112.5, dark_green_g: 112.5, fruit_g: 52.5 });
  });

  test('the totals are the sum of the scaled ingredients, not the old totals scaled', () => {
    const p = planLeftovers(dish, 100, undefined, 'dish');
    const sum = (k) => Math.round(p.ingredients.reduce((s, g) => s + g[k], 0) * 10) / 10;
    for (const k of ['calories', 'protein_g', 'carbs_g', 'fat_g']) assert.equal(p.nutr[k], sum(k));
  });

  test('an unweighable portion needs total_g, and names what could not be weighed', () => {
    const withTofu = [...dish, ...normalizeIngredients([{ food: 'tofu', amount: 1, unit: 'block', protein_g: 40, carbs_g: 8, fat_g: 20 }], 'dish').ingredients];
    assert.throws(() => planLeftovers(withTofu, 50, undefined, 'dish'), (e) => e instanceof ValidationError && /tofu/.test(e.message));
    const p = planLeftovers(withTofu, 200, 800, 'dish');
    assert.equal(p.factor, 0.75);
  });

  test('refuses a leftover that is not positive or not less than the dish', () => {
    assert.throws(() => planLeftovers(dish, 0, undefined, 'dish'), ValidationError);
    assert.throws(() => planLeftovers(dish, -5, undefined, 'dish'), ValidationError);
    assert.throws(() => planLeftovers(dish, 420, undefined, 'dish'), ValidationError);
    assert.throws(() => planLeftovers(dish, 10, 0, 'dish'), ValidationError);
    assert.throws(() => planLeftovers([], 10, undefined, 'dish'), ValidationError);
  });
});
