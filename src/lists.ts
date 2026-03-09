import type Database from 'better-sqlite3';
import { now, uuid } from './helpers.js';

export interface ListItem {
  id: string;
  list_name: string;
  text: string;
  done: boolean;
  deleted: boolean;
  created: string;
  updated: string;
}

function rowToItem(row: any): ListItem {
  return { ...row, done: !!row.done, deleted: !!row.deleted };
}

export function availableLists(db: Database.Database): string[] {
  return (db.prepare('SELECT name FROM lists ORDER BY name').all() as { name: string }[]).map(r => r.name);
}

export function listItems(db: Database.Database, listName: string): ListItem[] {
  return (db.prepare('SELECT * FROM list_items WHERE list_name = ? AND deleted = 0 ORDER BY created').all(listName) as any[]).map(rowToItem);
}

export function addItem(db: Database.Database, listName: string, text: string): ListItem {
  // Ensure list exists
  db.prepare('INSERT OR IGNORE INTO lists (name) VALUES (?)').run(listName);
  const n = now();
  const id = uuid();
  db.prepare('INSERT INTO list_items (id, list_name, text, done, deleted, created, updated) VALUES (?, ?, ?, 0, 0, ?, ?)').run(id, listName, text, n, n);
  return { id, list_name: listName, text, done: false, deleted: false, created: n, updated: n };
}

export function checkItem(db: Database.Database, listName: string, idPrefix: string): ListItem | null {
  const id = resolveListItemId(db, listName, idPrefix);
  if (!id) return null;
  const n = now();
  db.prepare('UPDATE list_items SET done = 1, updated = ? WHERE id = ?').run(n, id);
  return rowToItem(db.prepare('SELECT * FROM list_items WHERE id = ?').get(id));
}

export function uncheckItem(db: Database.Database, listName: string, idPrefix: string): ListItem | null {
  const id = resolveListItemId(db, listName, idPrefix);
  if (!id) return null;
  const n = now();
  db.prepare('UPDATE list_items SET done = 0, updated = ? WHERE id = ?').run(n, id);
  return rowToItem(db.prepare('SELECT * FROM list_items WHERE id = ?').get(id));
}

export function removeItem(db: Database.Database, listName: string, idPrefix: string): ListItem | null {
  const id = resolveListItemId(db, listName, idPrefix);
  if (!id) return null;
  const n = now();
  db.prepare('UPDATE list_items SET deleted = 1, updated = ? WHERE id = ?').run(n, id);
  return rowToItem(db.prepare('SELECT * FROM list_items WHERE id = ?').get(id));
}

export function createList(db: Database.Database, listName: string): boolean {
  const existing = db.prepare('SELECT name FROM lists WHERE name = ?').get(listName);
  if (existing) return false;
  db.prepare('INSERT INTO lists (name) VALUES (?)').run(listName);
  return true;
}

function resolveListItemId(db: Database.Database, listName: string, prefix: string): string | null {
  const exact = db.prepare('SELECT id FROM list_items WHERE id = ? AND list_name = ? AND deleted = 0').get(prefix, listName) as { id: string } | undefined;
  if (exact) return exact.id;
  const matches = db.prepare("SELECT id FROM list_items WHERE list_name = ? AND deleted = 0 AND id LIKE ? || '%'").all(listName, prefix) as { id: string }[];
  if (matches.length === 1) return matches[0].id;
  return null;
}

// Formatting
export function formatListItems(items: ListItem[], listName: string): string {
  if (!items.length) return `'${listName}' is empty.`;
  const lines = items.map(i => {
    const check = i.done ? '[x]' : '[ ]';
    return `${check} ${i.text}  [id: ${i.id.slice(0, 8)}]`;
  });
  return `**${listName}** (${items.length} items):\n${lines.join('\n')}`;
}
