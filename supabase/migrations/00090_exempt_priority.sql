-- A third value for `priority`: -1, "exempt".
--
-- Not everything with a time on it is a task. A work shift, an appointment, a reservation — these
-- happen at a moment, but nothing is OWED, so scoring them is wrong in both directions: there is
-- nothing to earn for "completing" a shift, and being penalised for not ticking one off is worse
-- than useless. Exempt items schedule, notify and draw on the calendar exactly like anything else,
-- score nothing either way, and check themselves off once their moment has passed.
--
--    1  important   counts double, both directions
--    0  normal      the default
--   -1  exempt      scores nothing; auto-completes when its moment passes
--
-- ONE column rather than a separate kind, because it is one choice made once at scheduling time —
-- important, normal, or exempt — and two fields carrying one choice is two fields that can
-- contradict each other. The cost is that an "important appointment" cannot be expressed; if that is
-- ever wanted, it is a second axis and needs a second column, not a fourth value.
--
-- The score multiplier is NOT (1 + priority) arithmetic any more. -1 happens to give zero, but the
-- code branches on exempt explicitly: it also suppresses the drain and the badge, which no
-- multiplier can express.

alter table list_items drop constraint if exists list_items_priority_ck;
alter table list_items add constraint list_items_priority_ck check (priority between -1 and 1);

comment on column list_items.priority is
  '1 important (counts double), 0 normal, -1 exempt (scores nothing, auto-completes when due passes)';
