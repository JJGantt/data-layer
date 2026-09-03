// The saved retailer catalogue (`shopping_items`), and the Walmart cart URL built out of it.
//
// Why a script and not an MCP tool: the catalogue is used for the occasional shopping errand, but an
// MCP tool's schema sits in EVERY session's context forever. And the job is not really "query the
// table" — it is "turn a shopping list into a cart URL", which a tool exposing rows would still
// leave the model to do by hand.
//
//   node cart.mjs list [walmart|amazon]        # the whole catalogue — it is small, just read it
//   node cart.mjs url spinach=2 milk=2 banana=7   # -> one URL that fills the Walmart cart
//   node cart.mjs add walmart <item_id> "<name>" [category]
//
// `url` matches each term against the name, case-insensitively. An ambiguous term is an ERROR that
// prints the candidates rather than a guess — putting the wrong food in a cart is worse than asking.

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
  if (!args.length) { console.error('usage: node cart.mjs url <term>=<qty> ...'); process.exit(1); }
  const all = await rows(`select=item_id,name,default_qty&retailer=eq.walmart`);
  const parts = [];
  let bad = false;
  for (const a of args) {
    const [term, qtyRaw] = a.split('=');
    const hits = all.filter((x) => x.name.toLowerCase().includes(term.toLowerCase().replace(/_/g, ' ')));
    if (hits.length === 0) { console.error(`no match: ${term}`); bad = true; continue; }
    if (hits.length > 1) {
      console.error(`ambiguous: ${term}`);
      for (const h of hits) console.error(`    ${h.item_id}  ${h.name}`);
      bad = true; continue;
    }
    const qty = Number(qtyRaw ?? hits[0].default_qty) || 1;
    parts.push({ ...hits[0], qty });
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
