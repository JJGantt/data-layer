-- RLS on the tables 00095 added.
--
-- Supabase leaves RLS off on a table created by migration, and the anon key is public — it ships
-- inside the Workset watch app — so a table without it is readable and writable by anyone holding
-- that key. Enabled with no policy, which is the right default here: service_role bypasses RLS, and
-- everything that touches these tables (the MCP, the HTTP API, the Gmail watcher) uses it.
--
-- Nothing reaches these with the anon key today. Adding a policy is the job of whatever first does,
-- granting only the verbs that client actually uses.

alter table walmart_cart       enable row level security;
alter table walmart_cart_state enable row level security;
alter table walmart_orders     enable row level security;
alter table gmail_watch_state  enable row level security;
