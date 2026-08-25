-- Repeating items: a dated item can recur instead of being one-shot.
--
-- ONE nullable column rather than a boolean plus a period. `repeat_every IS NULL` already means "does
-- not repeat", so a separate is_repeating flag would be a second field carrying the same fact — and
-- two fields carrying one fact can disagree (repeating=true with no period, repeating=false with one
-- set), which is a bug that has to be defended against at every write. Migration 00053 removed
-- exactly this shape from these same tables when `done` and `deleted` both meant "dealt with".
--
-- Stored as human-readable "<n> <unit>" — '1 day', '2 hours', '30 minutes', '1 week', '1 month',
-- '1 year' — so a row is legible in the table without a decoder. The hub parses it (parseRepeat) and
-- advances the item's `due` when it fires. Text rather than a Postgres interval because `due` itself
-- is local-naive text: recurrence here is calendar arithmetic on wall-clock values, not on instants,
-- so "every day at 9am" stays 9am across a DST boundary instead of drifting to 8 or 10.

alter table list_items add column if not exists repeat_every text;
