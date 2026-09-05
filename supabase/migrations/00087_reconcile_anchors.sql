-- Reconcile `scheduled_at` with `due` on rows left over from the marching-due era.
--
-- The two columns used to mean different things: `due` was the NEXT firing time and advanced every
-- time a repeating item fired, while `scheduled_at` stayed pinned at the first one so "has its
-- moment been and gone?" still had an answer (migration 00060).
--
-- 00085 removed the marching. Every occurrence is its own row, nothing advances a due, and every
-- surface reads `scheduled_at || due` as one value — so a row where they disagree is a row that
-- reads as permanently overdue while its actual due sits in the future. Harmless when the anchor
-- only drove a display flag; not harmless now that it drives a score that drains for as long as
-- something looks overdue.
--
-- One row was in that state (a daily item whose due had advanced once before 00085 ran). Nothing can
-- create another: setDue writes both columns together.
update list_items
   set scheduled_at = due
 where due is not null and scheduled_at is distinct from due;
