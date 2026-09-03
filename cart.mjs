// The saved retailer catalogue (`shopping_items`), and the Walmart cart URL built out of it.
//
// Why a script and not an MCP tool: the catalogue is used for the occasional shopping errand, but an
// MCP tool's schema sits in EVERY session's context forever. And the job is not really "query the
// table" — it is "turn a shopping list into a cart URL", which a tool exposing rows would still
// leave the model to do by hand.
//
//   node cart.mjs list [walmart|amazon]              # the whole catalogue — it is small, just read it
//   node cart.mjs url 13893738=2 44390948=7          # -> one URL that fills the Walmart cart
//   node cart.mjs add walmart <item_id> "<name>" [category]
//
// `url` takes ITEM IDS, not names. Reading `list` and picking the id is the step where the right
// product gets chosen, and it is not a step to automate away — a name matcher only re-introduces
// the chance of quietly picking the wrong food. All `url` does is check each id is really in the
// catalogue (a typo'd id fails SILENTLY inside the URL) and encode the pipes.

import { readFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
for (const line of readFileSync(path.join(here, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_KEY;
if (!URL_ || !KEY) { console.error('SUPABASE_URL / SUPABASE_KEY missing from data-layer/.env'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const rows = async (q) => {
  const r = await fetch(`${URL_}/rest/v1/shopping_items?${q}`, { headers: H });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
};

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'list') {
  const retailer = args[0];
  const all = await rows(`select=retailer,item_id,name,default_qty,category&order=retailer,category,name`
    + (retailer ? `&retailer=eq.${retailer}` : ''));
  for (const x of all) console.log(`${x.retailer.padEnd(8)} ${x.item_id.padEnd(12)} x${x.default_qty}  ${x.name}`);
  console.log(`\n${all.length} items`);

} else if (cmd === 'url') {
  if (!args.length) { console.error('usage: node cart.mjs url <item_id>=<qty> ...   (ids come from `list`)'); process.exit(1); }
  const all = await rows(`select=item_id,name,default_qty&retailer=eq.walmart`);
  const by = new Map(all.map((x) => [x.item_id, x]));
  const parts = [];
  let bad = false;
  for (const a of args) {
    const [id, qtyRaw] = a.split('=');
    const hit = by.get(id);
    if (!hit) { console.error(`not in the catalogue: ${id}   (run \`list\`, or \`add\` it first)`); bad = true; continue; }
    parts.push({ ...hit, qty: Number(qtyRaw ?? hit.default_qty) || 1 });
  }
  if (bad) process.exit(1);
  for (const p of parts) console.log(`# ${p.qty} x ${p.name}`);
  // %7C is the pipe separator. Quantities ADD to what is already in the cart — send deltas.
  console.log('\nhttps://affil.walmart.com/cart/addToCart?items='
    + parts.map((p) => `${p.item_id}%7C${p.qty}`).join(','));

} else if (cmd === 'add') {
  const [retailer, item_id, name, category] = args;
  if (!retailer || !item_id || !name) { console.error('usage: node cart.mjs add <retailer> <item_id> "<name>" [category]'); process.exit(1); }
  const r = await fetch(`${URL_}/rest/v1/shopping_items`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation,resolution=merge-duplicates' },
    body: JSON.stringify({ retailer, item_id, name, category: category || null }),
  });
  console.log(r.ok ? `saved: ${name}` : `failed ${r.status}: ${await r.text()}`);

} else {
  console.error('commands: list [retailer] | url <term>=<qty> ... | add <retailer> <item_id> "<name>" [category]');
  process.exit(1);
}
