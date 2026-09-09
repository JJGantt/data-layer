-- Fold `notes` into `list_items`. A note stops being a table and becomes what it already was: an
-- undated item on a list, whose `text` is the body and whose `title` is the name.
--
-- The two shapes were the same shape. `notes` was (name, content, updated); a list item is
-- (title, text, updated) plus everything a note could not have. Nothing distinguished a note except
-- what it was MISSING — no due date, so a note could never surface on a day or fire; no priority, no
-- completion, no soft delete, so deleting one was irreversible; and no seat in the realtime
-- publication (00078), so editing one told no surface anything.
--
-- Keying by name rather than id was the other cost. Deleting a note scanned every name
-- case-insensitively to find it — matching that exists only because a human cannot read the whole
-- list, over a set a model is handed in full. Folding in deletes that code rather than fixing it.
--
-- This is not the case 00056 declined. Reminders were refused a list of their own because a reminder
-- is a PREDICATE (`due is not null`) that any list's item can satisfy, so a `reminders` list would
-- have rebuilt the separation being removed. A note satisfies no predicate — an undated item with a
-- body is indistinguishable from a grocery entry — so `notes` is an ordinary list beside `books`,
-- not a class of item wearing a list as a disguise.
--
-- EXPAND half of an expand/contract pair. Purely additive: the deployed hub still selects from
-- `notes` on every /api/todos and PostgREST errors on a missing table, so 00093 drops it after the
-- redeploy.

insert into lists (name, emoji, created)
values ('notes', '📝', to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS'))
on conflict (name) do nothing;

-- `updated` is the only timestamp a note carried, so it stands in for `created` too. Guarded on the
-- title rather than the id because the ids are new here: a re-run must not duplicate the rows.
insert into list_items (id, list_name, text, title, due, scheduled_at, priority,
                        series_id, completed_at, deleted, created, updated)
select gen_random_uuid()::text, 'notes', coalesce(n.content, ''), n.name, null, null, 0,
       null, null, false, n.updated, n.updated
  from notes n
 where not exists (
   select 1 from list_items i
    where i.list_name = 'notes' and i.title = n.name and i.deleted = false
 );
