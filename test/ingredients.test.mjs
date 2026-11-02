// An entry's totals and produce are DERIVED from its ingredients (README: "a cached rollup, never an
// input"), and a recipe or a leftover is a scaling of them. A slip here changes every day's numbers.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeIngredients, rollup, produceRollup, scaleIngredients, ingredientGrams,
} from '../dist/ingredients.js';
import { ValidationError } from '../dist/helpers.js';

const oats = { food: 'rolled oats', amount: 0.5, unit: 'cup', protein_g: 5, carbs_g: 27, fat_g: 3 };
const broccoli = { food: 'broccoli', amount: 150, unit: 'g', protein_g: 4.2, carbs_g: 10, fat_g: 0.6, produce_g: 150, produce_type: 'dark_green_vegetable' };
const carrot = { food: 'carrot', amount: 1, unit: '', protein_g: 0.6, carbs_g: 6, fat_g: 0.1, produce_g: 61, produce_type: 'other_vegetable' };
const banana = { food: 'banana', amount: 1, unit: '', calories: 105, protein_g: 1.3, carbs_g: 27, fat_g: 0.4, produce_g: 118, produce_type: 'fruit' };

describe('normalizeIngredients', () => {
  test('derives calories from macros (4/4/9) only where none were stated', () => {
    const { ingredients } = normalizeIngredients([oats, banana], 'meal', true);
    assert.equal(ingredients[0].calories, 5 * 4 + 27 * 4 + 3 * 9);
    assert.equal(ingredients[1].calories, 105);
  });

  test('builds the display name from food, amount and unit', () => {
    const { ingredients } = normalizeIngredients([oats, banana], 'meal', true);
    assert.equal(ingredients[0].name, '0.5 cup rolled oats');
    assert.equal(ingredients[1].name, '1 banana');
  });

  test('refuses a food with no quantity when a quantity is required', () => {
    assert.throws(() => normalizeIngredients([{ ...oats, amount: undefined }], 'meal', true), ValidationError);
    assert.throws(() => normalizeIngredients([{ name: 'oats', protein_g: 1, carbs_g: 1, fat_g: 1 }], 'meal', true), ValidationError);
  });

  test('refuses missing, non-numeric or negative macros, and an empty list', () => {
    assert.throws(() => normalizeIngredients([{ ...oats, fat_g: undefined }], 'meal'), ValidationError);
    assert.throws(() => normalizeIngredients([{ ...oats, carbs_g: '27' }], 'meal'), ValidationError);
    assert.throws(() => normalizeIngredients([{ ...oats, protein_g: -1 }], 'meal'), ValidationError);
    assert.throws(() => normalizeIngredients([{ ...oats, calories: -5 }], 'meal'), ValidationError);
    assert.throws(() => normalizeIngredients([], 'meal'), ValidationError);
  });

  test('warns, without refusing, when stated calories are far from what the macros imply', () => {
    const milk = { food: 'milk', amount: 1, unit: 'cup', calories: 190, protein_g: 6, carbs_g: 8, fat_g: 0 };
    const { ingredients, warnings } = normalizeIngredients([milk], 'meal');
    assert.equal(ingredients[0].calories, 190);
    assert.equal(warnings.length, 1);
    // A small absolute gap on a small food is not worth a warning.
    assert.equal(normalizeIngredients([{ ...milk, calories: 80 }], 'meal').warnings.length, 0);
  });

  test('produce type and weight travel together', () => {
    assert.throws(() => normalizeIngredients([{ ...broccoli, produce_g: undefined }], 'meal'), ValidationError);
    assert.throws(() => normalizeIngredients([{ ...broccoli, produce_type: undefined }], 'meal'), ValidationError);
    assert.throws(() => normalizeIngredients([{ ...broccoli, produce_type: 'grain' }], 'meal'), ValidationError);
    assert.throws(() => normalizeIngredients([{ ...broccoli, produce_g: -1 }], 'meal'), ValidationError);
  });

  test('accepts the pre-rename produce types from a stale tool schema', () => {
    const { ingredients } = normalizeIngredients([
      { ...broccoli, produce_type: 'leafy' }, { ...carrot, produce_type: 'vegetable' },
    ], 'meal');
    assert.equal(ingredients[0].produce_type, 'dark_green_vegetable');
    assert.equal(ingredients[1].produce_type, 'other_vegetable');
  });

  test('leaves produce fields off a non-produce ingredient', () => {
    const { ingredients } = normalizeIngredients([oats], 'meal');
    assert.equal('produce_g' in ingredients[0], false);
    assert.equal('produce_type' in ingredients[0], false);
  });
});

describe('rollup', () => {
  test('totals are the sum of the ingredients, field by field, to a tenth', () => {
    const { ingredients } = normalizeIngredients([oats, broccoli, banana], 'meal');
    assert.deepEqual(rollup(ingredients), {
      calories: 155 + 62 + 105,
      protein_g: 10.5, carbs_g: 64, fat_g: 4,
    });
  });

  test('is free of float drift', () => {
    const tenth = { food: 'x', amount: 1, unit: 'g', protein_g: 0.1, carbs_g: 0.2, fat_g: 0.1 };
    const { ingredients } = normalizeIngredients([tenth, tenth, tenth], 'meal');
    assert.equal(rollup(ingredients).protein_g, 0.3);
    assert.equal(rollup(ingredients).carbs_g, 0.6);
  });
});

describe('produceRollup', () => {
  test('dark green counts toward both dark green and vegetables; fruit only toward fruit', () => {
    const { ingredients } = normalizeIngredients([oats, broccoli, carrot, banana], 'meal');
    assert.deepEqual(produceRollup(ingredients), { veg_g: 211, dark_green_g: 150, fruit_g: 118 });
  });

  test('is all zeros for a meal with no produce', () => {
    const { ingredients } = normalizeIngredients([oats], 'meal');
    assert.deepEqual(produceRollup(ingredients), { veg_g: 0, dark_green_g: 0, fruit_g: 0 });
  });
});

describe('scaleIngredients', () => {
  test('scales amount, macros and produce weight together and renames from the new amount', () => {
    const { ingredients } = normalizeIngredients([broccoli, oats], 'meal');
    const { ingredients: doubled } = normalizeIngredients(scaleIngredients(ingredients, 2), 'meal');
    assert.equal(doubled[0].amount, 300);
    assert.equal(doubled[0].produce_g, 300);
    assert.equal(doubled[0].protein_g, 8.4);
    assert.equal(doubled[0].name, '300 g broccoli');
    assert.equal(doubled[1].amount, 1);
    assert.equal(doubled[1].calories, 310);
  });

  test('rounds amounts to significant figures, not a fixed three decimals', () => {
    const { ingredients } = normalizeIngredients([{ ...broccoli, amount: 161 }, { ...oats, amount: 0.75 }], 'meal');
    const scaled = scaleIngredients(ingredients, 0.787);
    assert.equal(scaled[0].amount, 127);
    assert.equal(scaled[1].amount, 0.59);
  });

  test('keeps the label of a legacy row that has no structured portion', () => {
    const { ingredients } = normalizeIngredients([{ name: 'Protein bar', protein_g: 20, carbs_g: 22, fat_g: 7 }], 'meal');
    const { ingredients: half } = normalizeIngredients(scaleIngredients(ingredients, 0.5), 'meal');
    assert.equal(half[0].name, 'Protein bar');
    assert.equal(half[0].protein_g, 10);
  });
});

describe('ingredientGrams', () => {
  test('grams come from a gram portion, else from the produce weight, else are unknown', () => {
    assert.equal(ingredientGrams({ unit: 'g', amount: 200 }), 200);
    assert.equal(ingredientGrams({ unit: ' G ', amount: 50 }), 50);
    assert.equal(ingredientGrams({ unit: '', amount: 0.5, produce_g: 70 }), 70);
    assert.equal(ingredientGrams({ unit: 'block', amount: 1 }), null);
    assert.equal(ingredientGrams({ unit: 'cup', amount: 1 }), null);
  });
});
