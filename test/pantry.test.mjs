import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servingsFor, labelIngredient, classify, pantryPatch, HOME_RADIUS_M } from '../dist/pantry.js';
import { pickFixAt } from '../dist/location.js';

const yumYum = { id: 1, product: "Terry Ho's Reduced Calorie Yum Yum Sauce", serving_amount: 2, serving_unit: 'tbsp', serving_g: 30,
  calories: 90, protein_g: 0, carbs_g: 2, fat_g: 7, produce_type: null };
const bagel = { id: 2, product: "Dave's Killer Bread Epic Everything Bagel", serving_amount: 1, serving_unit: 'bagel', serving_g: 99,
  calories: 260, protein_g: 13, carbs_g: 45, fat_g: 4.5, produce_type: null };
const edamame = { id: 3, product: 'Great Value Edamame in Pods', serving_amount: 1, serving_unit: 'cup', serving_g: 85,
  calories: 100, protein_g: 9, carbs_g: 8, fat_g: 4, produce_type: 'other_vegetable' };

test('a portion converts to label servings by unit kind', () => {
  assert.equal(servingsFor(yumYum, 2, 'tbsp'), 1, 'the label unit');
  assert.equal(servingsFor(yumYum, 4, 'Tablespoons'), 2, 'aliases and plurals');
  assert.equal(servingsFor(yumYum, 3, 'tsp'), 0.5, 'another volume');
  assert.equal(servingsFor(yumYum, 60, 'g'), 2, 'grams through the printed weight');
  assert.equal(servingsFor(yumYum, 1.5, 'serving'), 1.5);
  assert.equal(servingsFor(bagel, 2, ''), 2, 'a bare count against a counted serving');
  assert.equal(servingsFor(bagel, 1, 'cup'), null, 'volume against a count cannot be related');
  assert.equal(servingsFor({ ...yumYum, serving_g: null }, 30, 'g'), null, 'no weight printed: grams cannot be related');
});

test('the logged ingredient carries label macros scaled to the portion', () => {
  const ing = labelIngredient(yumYum, 1, 'tbsp');
  assert.deepEqual(ing, { food: yumYum.product, amount: 1, unit: 'tbsp', calories: 45, protein_g: 0, carbs_g: 1, fat_g: 3.5 });
  assert.throws(() => labelIngredient(bagel, 1, 'cup'), /can't convert/);
  assert.throws(() => labelIngredient(yumYum, 0, 'tbsp'), /positive/);
});

test('packaged produce gets its gram weight for the produce goals', () => {
  const ing = labelIngredient(edamame, 0.5, 'cup');
  assert.equal(ing.produce_type, 'other_vegetable');
  assert.equal(ing.produce_g, 42.5);
});

test('away only when the whole fix is outside the home radius', () => {
  const home = { lat: 40, lon: -75 };
  assert.equal(classify(home, { ...home, acc: 10 }).state, 'home');
  // ~1.1 km north
  const far = { lat: 40.01, lon: -75 };
  assert.equal(classify(home, { ...far, acc: 20 }).state, 'away');
  assert.equal(classify(home, { ...far, acc: 2000 }).state, 'home', 'a fix too coarse to place him elsewhere is not away');
  // just past the radius with a tight fix
  const edge = { lat: home.lat + (HOME_RADIUS_M + 60) / 111_000, lon: home.lon };
  assert.equal(classify(home, { ...edge, acc: 10 }).state, 'away');
});

test('the fix for a past moment is the last one before it, preferring a nearby GPS-grade fix', () => {
  const t = (hm) => `2026-11-25T${hm}:00Z`;
  const at = Date.parse(t('18:00'));
  const gps = { device: 'phone', lat: 1, lon: 1, acc: 10, at: t('17:50') };
  const coarse = { device: 'watch', lat: 2, lon: 2, acc: 900, at: t('17:55') };
  const after = { device: 'phone', lat: 3, lon: 3, acc: 10, at: t('18:20') };
  assert.equal(pickFixAt([gps, coarse, after], at), gps);
  assert.equal(pickFixAt([coarse, after], at), coarse, 'coarse is still better than nothing before');
  assert.equal(pickFixAt([after], at), after, 'nothing before: the first after');
  assert.equal(pickFixAt([], at), null);
});

test('a new pantry row needs its whole label; an edit only what it changes', () => {
  assert.throws(() => pantryPatch({ names: ['teriyaki'], product: 'G Hughes Sugar Free Teriyaki' }, true), /needs serving_amount/);
  assert.deepEqual(pantryPatch({ names: [' Teriyaki ', 'teriyaki'] }, false), { names: ['teriyaki'] });
  assert.throws(() => pantryPatch({ calories: -1 }, false), /non-negative/);
  assert.throws(() => pantryPatch({ produce_type: 'grain' }, false), /produce_type/);
});
