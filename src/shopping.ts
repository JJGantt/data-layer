// The saved retailer catalogue, and the Walmart cart URL built out of it.
//
// Walmart loads an entire basket from one navigation, so the item ids are the only thing a cart run
// needs — no browsing, no clicking. Amazon has no working equivalent (its documented
// /gp/aws/cart/add.html adds nothing), so an Amazon row saves the search but not the session.

import { getClient } from './client.js';
import { now } from './helpers.js';

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
      `call get_shopping_items. An item not bought before is not saved on purpose (the catalogue is ` +
      `what Jared has bought, not what went in a cart) — build https://affil.walmart.com/cart/addToCart?items=<id>%7C<qty> by hand instead`);
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

// ── The recorded cart ──
//
// These rows are written from what /cart actually showed, never from what was requested. The
// difference is not pedantry: the affiliate add-to-cart endpoint returns its normal success page
// while silently dropping items, so "what I asked for" and "what is in the cart" diverge with no
// error to notice. Only the second one is worth storing.

export type CartLine = { item_id: string; name: string; qty: number; line_total?: number | null };

export type CartSnapshot = {
  lines: CartLine[];
  observed_at: string | null;
  unit_count: number | null;
  subtotal: number | null;
  savings: number | null;
  source: string | null;
};

export async function getCart(): Promise<CartSnapshot> {
  const c = getClient();
  const [linesRes, stateRes] = await Promise.all([
    c.from('walmart_cart').select('item_id,name,qty,line_total').order('name'),
    c.from('walmart_cart_state').select('observed_at,unit_count,subtotal,savings,source').eq('id', true).maybeSingle(),
  ]);
  if (linesRes.error) throw new Error(linesRes.error.message);
  if (stateRes.error) throw new Error(stateRes.error.message);
  const s = stateRes.data || {} as any;
  return {
    lines: (linesRes.data || []) as CartLine[],
    observed_at: s.observed_at ?? null,
    unit_count: s.unit_count ?? null,
    subtotal: s.subtotal ?? null,
    savings: s.savings ?? null,
    source: s.source ?? null,
  };
}

// Replaces the cart wholesale. There is deliberately no add/increment counterpart: an incremental
// writer would drift the moment a write silently failed, and the whole reason this table exists is
// that such failures happen and are invisible.
export async function setCart(
  lines: CartLine[],
  meta: { unit_count?: number | null; subtotal?: number | null; savings?: number | null; source?: string } = {},
): Promise<string> {
  const c = getClient();
  const rows = (lines || []).map(l => ({
    item_id: String(l.item_id),
    name: l.name,
    qty: Number(l.qty) || 0,
    line_total: l.line_total ?? null,
    observed_at: now(),
  }));
  const dupes = rows.map(r => r.item_id).filter((id, i, a) => a.indexOf(id) !== i);
  if (dupes.length) throw new Error(`same item_id twice: ${[...new Set(dupes)].join(', ')}`);

  const del = await c.from('walmart_cart').delete().neq('item_id', '');
  if (del.error) throw new Error(del.error.message);
  if (rows.length) {
    const ins = await c.from('walmart_cart').insert(rows);
    if (ins.error) throw new Error(ins.error.message);
  }
  const upd = await c.from('walmart_cart_state').update({
    observed_at: now(),
    unit_count: meta.unit_count ?? rows.reduce((n, r) => n + r.qty, 0),
    subtotal: meta.subtotal ?? null,
    savings: meta.savings ?? null,
    source: meta.source ?? 'session',
  }).eq('id', true);
  if (upd.error) throw new Error(upd.error.message);

  return rows.length
    ? `Cart recorded: ${rows.length} products, ${rows.reduce((n, r) => n + r.qty, 0)} units`
    : 'Cart recorded: empty';
}

export function formatCart(s: CartSnapshot): string {
  if (!s.lines.length) {
    return `Cart is empty${s.observed_at ? ` (as of ${s.observed_at}${s.source ? `, via ${s.source}` : ''})` : ' — never recorded'}.`;
  }
  const w = Math.max(...s.lines.map(l => l.item_id.length));
  const head = `Cart: ${s.lines.length} products, ${s.unit_count ?? s.lines.reduce((n, l) => n + l.qty, 0)} units` +
    (s.subtotal != null ? `, subtotal $${s.subtotal}` : '') +
    (s.savings != null ? ` (saved $${s.savings})` : '') +
    (s.observed_at ? `\nObserved ${s.observed_at}${s.source ? ` via ${s.source}` : ''}` : '');
  return head + '\n' + s.lines
    .map(l => `  ${String(l.item_id).padEnd(w)}  ${String(l.qty).padStart(2)} x ${l.name}${l.line_total != null ? `  $${l.line_total}` : ''}`)
    .join('\n');
}

// Called by the Gmail watcher, not by a session: checkout happens when nothing is running. Returns
// false when the order number was already recorded, which is the case that matters — an order
// containing alcohol produces two confirmation mails, and Pub/Sub redelivers on its own.
export async function recordOrder(o: {
  order_number: string; order_date?: string | null; fulfillment?: string | null;
  item_count?: number | null; total?: number | null; savings?: number | null; gmail_id?: string | null;
}): Promise<{ recorded: boolean; cleared: boolean }> {
  const c = getClient();
  const order_number = String(o.order_number).replace(/^#/, '').trim();
  if (!order_number) throw new Error('no order number');

  const existing = await c.from('walmart_orders').select('order_number').eq('order_number', order_number).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return { recorded: false, cleared: false };

  const ins = await c.from('walmart_orders').insert({
    order_number,
    order_date: o.order_date ?? null,
    fulfillment: o.fulfillment ?? null,
    item_count: o.item_count ?? null,
    total: o.total ?? null,
    savings: o.savings ?? null,
    gmail_id: o.gmail_id ?? null,
    cart_cleared: true,
    detected_at: now(),
  });
  if (ins.error) throw new Error(ins.error.message);

  await setCart([], { source: 'order-confirmation', unit_count: 0 });
  return { recorded: true, cleared: true };
}
