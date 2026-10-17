-- Orders are written in two passes (CapitalGrilleApp/Orders.swift): first as heard, the moment the
-- recording is transcribed, then matched to the menu a few seconds later. `standardized_at` is when the
-- second pass looked at the row (null = still as heard); a row it found no menu item for keeps its
-- heard wording. `heard_name` keeps that wording after a match renames the row, so a wrong match can be
-- seen for what it was.
alter table public.cg_orders add column heard_name text;
alter table public.cg_orders add column standardized_at timestamptz;
-- Rows written before this were matched by the one-pass taker already.
update public.cg_orders set standardized_at = created_at;
