-- The Walmart cart, recorded rather than inferred, plus the orders that empty it.
--
-- Walmart exposes no cart API, so the only way to know what is in the cart is to read /cart in a
-- signed-in browser. That read is expensive enough that it should not happen on a timer, and the
-- cart only changes at two moments: when a session adds to it, and at checkout.
--
-- So the cart here is written from OBSERVATION, never from arithmetic. A session that touches the
-- cart reads /cart afterwards and replaces these rows wholesale. It never increments. That
-- distinction is the whole point: on 2026-09-09 an affiliate add-to-cart call silently dropped five
-- of nine items while reporting success, so a running total of what was requested would have been
-- wrong about five of them, and wrong with no signal. A post-read snapshot was right.
--
-- Checkout is the other half, and no session is running when it happens. A Gmail watcher detects
-- the Walmart order-confirmation mail and clears the cart here, which is why walmart_orders exists
-- alongside: the order number is the dedupe key, and an order containing alcohol generates TWO
-- confirmations (groceries and the partner liquor store check out separately).

create table if not exists walmart_cart (
  item_id     text primary key,          -- Walmart /ip/<slug>/<id> id
  name        text not null,             -- as the CART renders it, which is not always the catalogue name
  qty         integer not null,
  line_total  numeric,                   -- what the cart showed for the line, nullable when not parsed
  observed_at timestamptz not null default now()
);

-- Snapshot metadata for the cart as a whole. Singleton: the cart has one state, not a history.
create table if not exists walmart_cart_state (
  id          boolean primary key default true check (id),
  observed_at timestamptz,
  unit_count  integer,                   -- Walmart's own "N items" count, which counts units
  subtotal    numeric,
  savings     numeric,
  source      text                       -- how it was last written: 'session' or 'order-confirmation'
);

insert into walmart_cart_state (id) values (true) on conflict (id) do nothing;

create table if not exists walmart_orders (
  order_number text primary key,         -- '2000151-96175315', the '#' stripped
  order_date   date,
  fulfillment  text,                     -- 'delivery' | 'pickup' | 'shipping', from the subject line
  item_count   integer,                  -- as CONFIRMED; substitutions and weighed produce move this
  total        numeric,
  savings      numeric,
  gmail_id     text,                     -- the message this was parsed from
  detected_at  timestamptz not null default now(),
  cart_cleared boolean not null default false
);

create index if not exists walmart_orders_date_idx on walmart_orders (order_date desc);

-- Gmail push subscription state, kept here rather than on the Pi so a health check can read it
-- without shelling into the box.
--
-- history_id is the resume point: a Pub/Sub notification carries only a historyId, so the watcher
-- asks history.list for everything between the last one it processed and this one. Losing it means
-- losing the ability to tell what changed, so it is committed after each successful batch.
--
-- watch_expiration is the one that kills this silently. A Gmail watch registration lasts 7 days and
-- then simply stops delivering, with no error anywhere. Renewal is daily, and the health check
-- asserts this column is in the future rather than asserting the service is running.
create table if not exists gmail_watch_state (
  id               boolean primary key default true check (id),
  history_id       text,
  watch_expiration timestamptz,
  last_renewed_at  timestamptz,
  last_event_at    timestamptz,          -- last notification actually received, for liveness-vs-function
  last_error       text
);

insert into gmail_watch_state (id) values (true) on conflict (id) do nothing;
