-- `scheduled_at`: when a dated item was FIRST due. Set once, then never moved.
--
-- EXPIRED is a separate concept from REPEATING, and this column is what keeps them separate. `due`
-- is the NEXT firing time, so a repeating item's due marches permanently into the future — the
-- moment it fires, its due is tomorrow. Judging "has this been and gone?" from `due` would therefore
-- mean a repeating item is never expired, which is backwards: it has fired, it is still outstanding,
-- and it needs dealing with. The anchor stays put and answers that question the same way for a
-- one-shot and a repeater alike. Repeating governs only whether it fires AGAIN.
--
-- It also retires a wart from 00058. Month arithmetic clamps (Jan 31 + 1 month = Feb 28) and the
-- clamp used to stick, because each advance read the day-of-month off the date the previous one
-- produced, so a monthly item anchored on the 31st degraded to the 28th permanently. Advancing from
-- the anchor instead of from the last result keeps the intended day of month forever.

alter table list_items add column if not exists scheduled_at text;

-- Everything already dated was, by definition, first scheduled for the due it currently holds.
update list_items set scheduled_at = due where due is not null and scheduled_at is null;
