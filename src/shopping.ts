// The saved retailer catalogue, and the Walmart cart URL built out of it.
//
// Walmart loads an entire basket from one navigation, so the item ids are the only thing a cart run
// needs — no browsing, no clicking. Amazon has no working equivalent (its documented
// /gp/aws/cart/add.html adds nothing), so an Amazon row saves the search but not the session.

import { getClient } from './client.js';

export type ShoppingItem = {
  retailer: string; item_id: string; name: string;
  default_qty: number; category: string | null;
};

export async function listItems(retailer?: string): Promise<ShoppingItem[]> {
  let q = getClient().from('shopping_items')
    .select('retailer,item_id,name,default_qty,category')
    .order('retailer').order('category').order('name');
  if (retailer) q = q.eq('retailer', retailer);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []) as ShoppingItem[];
}

export function formatItems(items: ShoppingItem[]): string {
  if (!items.length) return 'No saved items.';
  const w = Math.max(...items.map(i => i.item_id.length));
  return `${items.length} saved items — pass the item_id, never the name:\n` +
    items.map(i => `  ${i.retailer.padEnd(8)} ${i.item_id.padEnd(w)}  ${i.name}${i.category ? `  [${i.category}]` : ''}`).join('\n');
}

// Quantities ADD to whatever is already in the cart, so callers pass the DELTA, not the target.
// An id not in the catalogue is an error rather than a skipped entry: a bad id fails silently
// inside the URL, and a cart that is quietly short by one item is worse than a refusal.
export async function walmartCartUrl(items: { item_id: string; qty?: number }[]): Promise<string> {
  if (!items?.length) throw new Error('no items given');
  const saved = new Map((await listItems('walmart')).map(i => [i.item_id, i]));
  const missing = items.filter(i => !saved.has(String(i.item_id)));
  if (missing.length) {
    throw new Error(`not in the catalogue: ${missing.map(m => m.item_id).join(', ')} — ` +
      `call get_shopping_items, or save_shopping_item first`);
  }
  const parts = items.map(i => {
    const s = saved.get(String(i.item_id))!;
    return { name: s.name, qty: Number(i.qty ?? s.default_qty) || 1, item_id: String(i.item_id) };
  });
  return parts.map(p => `# ${p.qty} x ${p.name}`).join('\n') +
    '\n\nNavigate to this URL in the signed-in browser, then confirm against /cart:\n' +
    'https://affil.walmart.com/cart/addToCart?items=' +
    parts.map(p => `${p.item_id}%7C${p.qty}`).join(',');
}

export async function saveItem(i: { retailer: string; item_id: string; name: string; default_qty?: number; category?: string }): Promise<string> {
  const { error } = await getClient().from('shopping_items')
    .upsert({ ...i, item_id: String(i.item_id) }, { onConflict: 'retailer,item_id' });
  if (error) throw new Error(error.message);
  return `Saved: ${i.name} (${i.retailer} ${i.item_id})`;
}
