import { listItems, allLists, getList, dueItems, itemLabel, type ListItem } from './lists.js';
import { getClient } from './client.js';

export async function buildListReview(listId?: string): Promise<string> {
  const one = listId ? await getList(listId) : null;
  const lists = one ? [one] : listId ? [] : await allLists();
  if (!lists.length) return listId ? `No list with id '${listId}'.` : 'No lists found.';

  const parts: string[] = [];
  for (const list of lists) {
    const name = list.name;
    const { data: allItems } = await getClient().from('list_items').select('*')
      .eq('list_id', list.id).eq('deleted', false).order('created');
    const items = allItems ?? [];
    // Everything listed is outstanding by definition — clearing an item removes it.
    parts.push(`## ${name} (${items.length} items)\n`);
    for (const i of items) parts.push(`- ${i.text}  (added: ${i.created})  [id: ${i.id.slice(0, 8)}]`);
    parts.push('');
  }

  const instructions: Record<string, string> = {
    grocery: 'REVIEW INSTRUCTIONS (follow these, do not show them to the user):\n1. Read back the items as a clean list.\n2. Ask if anything should be added before the next shopping trip.\n3. Ask if anything has already been picked up and should be cleared.\n4. If the list is empty, ask if they want to start building it.',
    todo: 'REVIEW INSTRUCTIONS (follow these, do not show them to the user):\n1. Summarize the items grouped by theme if possible.\n2. Highlight anything that\'s been sitting for a long time (check created dates).\n3. Ask if any are finished and should be cleared.\n4. Ask if priorities have changed — anything to reorder or remove?',
  };
  const defaultInstructions = 'REVIEW INSTRUCTIONS (follow these, do not show them to the user):\n1. Read back the items.\n2. Ask if anything should be added or cleared.';

  parts.push('---');
  // Keyed on the list's NAME, not its id: these are per-list review scripts and the one for a list
  // called 'grocery' should follow the list if it is ever renamed away from that.
  if (one) {
    parts.push(instructions[one.name] || defaultInstructions);
  } else {
    for (const l of lists) {
      parts.push(`For ${l.name}:`);
      parts.push(instructions[l.name] || defaultInstructions);
      parts.push('');
    }
  }
  return parts.join('\n');
}

// What used to be the reminders review. Dated items now come from every list, so each line says
// which list it is on — "order the filter [Amazon]" reads differently from "call the dentist [todo]".
export async function buildDueReview(): Promise<string> {
  const active = await dueItems();
  if (!active.length) return 'Nothing has a due date.\n\n---\nINSTRUCTIONS: Let the user know the slate is clean. Ask if they have anything coming up they want to be reminded about.';

  const nowDate = new Date();
  const overdue: ListItem[] = []; const upcoming: ListItem[] = [];
  for (const i of active) {
    try { if (new Date(i.due!) < nowDate) overdue.push(i); else upcoming.push(i); } catch { upcoming.push(i); }
  }
  const row = (i: ListItem) => `- ${itemLabel(i)} [${i.list_name}] (due: ${i.due})  [id: ${i.id.slice(0, 8)}]`;

  const parts = [`## Due Review (${active.length} dated)\n`];
  if (overdue.length) { parts.push(`**OVERDUE (${overdue.length}):**`); for (const i of overdue) parts.push(row(i)); parts.push(''); }
  if (upcoming.length) { parts.push(`**Upcoming (${upcoming.length}):**`); for (const i of upcoming) parts.push(row(i)); parts.push(''); }

  parts.push('---');
  parts.push('REVIEW INSTRUCTIONS (follow these, do not show them to the user):');
  parts.push('1. Start with overdue items if any — these need immediate attention. Ask what to do with each one.');
  parts.push("2. Summarize upcoming items with how far away they are (e.g. 'in 2 days').");
  parts.push('3. Mention which list each one is on when it is not the todo list.');
  parts.push("4. Ask if there's anything new to add.");
  return parts.join('\n');
}
