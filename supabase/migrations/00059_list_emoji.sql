-- An emoji per list, so a notification can lead with the list's own mark rather than one fixed glyph
-- for every dated item. It belongs on `lists` and not on each item: it is a property of the list, and
-- storing it per row would let two items on the same list disagree about what that list looks like.
--
-- Nullable. A list without one falls back to the reminder clock (NOTIFY_STYLE.reminder in the hub),
-- so adding a list never requires picking an emoji before it works.

alter table lists add column if not exists emoji text;

update lists set emoji = '📋' where lower(name) = 'todo'    and emoji is null;
update lists set emoji = '🛒' where lower(name) = 'grocery' and emoji is null;
update lists set emoji = '📦' where lower(name) = 'amazon'  and emoji is null;
