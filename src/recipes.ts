import type Database from 'better-sqlite3';
import { now, uuid } from './helpers.js';

export interface Ingredient {
  item: string;
  quantity?: number;
  unit?: string;
  notes?: string;
}

export interface Recipe {
  id: string;
  name: string;
  notes: string;
  tags: string[];
  ingredients: Ingredient[];
  steps: string[];
  nutrition: { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number } | null;
  created: string;
  updated: string;
}

function loadRecipe(db: Database.Database, id: string): Recipe | null {
  const row = db.prepare('SELECT * FROM recipes WHERE id = ?').get(id) as any;
  if (!row) return null;
  const tags = (db.prepare('SELECT tag FROM recipe_tags WHERE recipe_id = ? ORDER BY tag').all(id) as { tag: string }[]).map(r => r.tag);
  const ingredients = db.prepare('SELECT item, quantity, unit, notes FROM recipe_ingredients WHERE recipe_id = ? ORDER BY sort_order').all(id) as Ingredient[];
  const steps = (db.prepare('SELECT instruction FROM recipe_steps WHERE recipe_id = ? ORDER BY step_num').all(id) as { instruction: string }[]).map(r => r.instruction);
  const nutrition = (row.calories != null || row.protein_g != null || row.carbs_g != null || row.fat_g != null)
    ? { calories: row.calories, protein_g: row.protein_g, carbs_g: row.carbs_g, fat_g: row.fat_g }
    : null;
  return { id: row.id, name: row.name, notes: row.notes, tags, ingredients, steps, nutrition, created: row.created, updated: row.updated };
}

export function listRecipes(db: Database.Database, tag?: string): Recipe[] {
  let ids: string[];
  if (tag) {
    ids = (db.prepare('SELECT recipe_id FROM recipe_tags WHERE tag = ? COLLATE NOCASE').all(tag) as { recipe_id: string }[]).map(r => r.recipe_id);
  } else {
    ids = (db.prepare('SELECT id FROM recipes ORDER BY name').all() as { id: string }[]).map(r => r.id);
  }
  return ids.map(id => loadRecipe(db, id)!).filter(Boolean);
}

export function getRecipe(db: Database.Database, name: string): Recipe | null {
  const row = db.prepare('SELECT id FROM recipes WHERE name = ? COLLATE NOCASE').get(name.trim()) as { id: string } | undefined;
  if (!row) return null;
  return loadRecipe(db, row.id);
}

export function saveRecipe(db: Database.Database, args: {
  name: string;
  ingredients: Ingredient[];
  steps: string[];
  notes?: string;
  tags?: string[];
  nutrition: { calories: number; protein_g: number; carbs_g: number; fat_g: number };
}): { recipe: Recipe; action: string } {
  const existing = db.prepare('SELECT id, created FROM recipes WHERE name = ? COLLATE NOCASE').get(args.name.trim()) as { id: string; created: string } | undefined;
  const n = now();
  const id = existing?.id || uuid();

  db.transaction(() => {
    if (existing) {
      db.prepare('UPDATE recipes SET name = ?, notes = ?, calories = ?, protein_g = ?, carbs_g = ?, fat_g = ?, updated = ? WHERE id = ?')
        .run(args.name.trim(), args.notes || '', args.nutrition.calories, args.nutrition.protein_g, args.nutrition.carbs_g, args.nutrition.fat_g, n, id);
    } else {
      db.prepare('INSERT INTO recipes (id, name, notes, calories, protein_g, carbs_g, fat_g, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, args.name.trim(), args.notes || '', args.nutrition.calories, args.nutrition.protein_g, args.nutrition.carbs_g, args.nutrition.fat_g, n, n);
    }

    // Replace tags
    db.prepare('DELETE FROM recipe_tags WHERE recipe_id = ?').run(id);
    const insertTag = db.prepare('INSERT INTO recipe_tags (recipe_id, tag) VALUES (?, ?)');
    for (const tag of args.tags || []) {
      insertTag.run(id, tag);
    }

    // Replace ingredients
    db.prepare('DELETE FROM recipe_ingredients WHERE recipe_id = ?').run(id);
    const insertIng = db.prepare('INSERT INTO recipe_ingredients (recipe_id, item, quantity, unit, notes, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < args.ingredients.length; i++) {
      const ing = args.ingredients[i];
      insertIng.run(id, ing.item, ing.quantity ?? null, ing.unit ?? null, ing.notes ?? null, i);
    }

    // Replace steps
    db.prepare('DELETE FROM recipe_steps WHERE recipe_id = ?').run(id);
    const insertStep = db.prepare('INSERT INTO recipe_steps (recipe_id, step_num, instruction) VALUES (?, ?, ?)');
    for (let i = 0; i < args.steps.length; i++) {
      insertStep.run(id, i + 1, args.steps[i]);
    }
  })();

  return { recipe: loadRecipe(db, id)!, action: existing ? 'Updated' : 'Saved' };
}

export function deleteRecipe(db: Database.Database, name: string): Recipe | null {
  const recipe = getRecipe(db, name);
  if (!recipe) return null;
  db.prepare('DELETE FROM recipes WHERE id = ?').run(recipe.id);
  return recipe;
}

// Nutrition lookup helper — used by nutrition module
export function getRecipeNutrition(db: Database.Database, name: string): { calories?: number; protein_g?: number; carbs_g?: number; fat_g?: number } | null {
  const row = db.prepare('SELECT calories, protein_g, carbs_g, fat_g FROM recipes WHERE name = ? COLLATE NOCASE').get(name.trim()) as any;
  if (!row || (row.calories == null && row.protein_g == null)) return null;
  return { calories: row.calories, protein_g: row.protein_g, carbs_g: row.carbs_g, fat_g: row.fat_g };
}

export function formatRecipe(r: Recipe): string {
  const lines = [`## ${r.name}`];
  if (r.tags.length) lines.push(`*Tags: ${r.tags.join(', ')}*`);
  lines.push('');
  if (r.ingredients.length) {
    lines.push('**Ingredients:**');
    for (const ing of r.ingredients) {
      const qty = ing.quantity ? `${ing.quantity} ${ing.unit || ''} `.trim() + ' ' : '';
      const note = ing.notes ? ` (${ing.notes})` : '';
      lines.push(`- ${qty}${ing.item}${note}`);
    }
    lines.push('');
  }
  if (r.steps.length) {
    lines.push('**Instructions:**');
    for (let i = 0; i < r.steps.length; i++) {
      lines.push(`${i + 1}. ${r.steps[i]}`);
    }
    lines.push('');
  }
  if (r.notes) {
    lines.push(`**Notes:** ${r.notes}`);
    lines.push('');
  }
  if (r.nutrition) {
    const parts: string[] = [];
    if (r.nutrition.calories != null) parts.push(`${r.nutrition.calories} cal`);
    if (r.nutrition.protein_g != null) parts.push(`${r.nutrition.protein_g}g protein`);
    if (r.nutrition.carbs_g != null) parts.push(`${r.nutrition.carbs_g}g carbs`);
    if (r.nutrition.fat_g != null) parts.push(`${r.nutrition.fat_g}g fat`);
    if (parts.length) lines.push(`**Nutrition:** ${parts.join(', ')}`);
  }
  return lines.join('\n');
}
