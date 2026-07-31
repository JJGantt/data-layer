-- The set watcher trigger must write occurred_at in the SAME format everything else
-- in this system uses, which is naive local wall-clock: 'YYYY-MM-DDTHH:MM:SS', no
-- offset, no space separator. That is what helpers.toEastern() produces and what the
-- hub's wallClockMs() regex requires — given anything else it returns NaN, and the
-- whole workout card collapses ("time since last set" reads NaN and the day's sets
-- vanish).
--
-- `sets.occurred_at` is TEXT, so a timestamptz inserted into it is stringified
-- verbatim rather than rejected: the first watch-logged set landed as
-- '2026-07-31 19:14:11.459+00' beside rows reading '2026-07-30T12:10:32'. Wrong
-- shape, and four hours off besides, since it was UTC where the rest are Eastern.

create or replace function workset_report_to_set() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    w set_watcher%rowtype;
    new_id bigint;
begin
    select * into w from set_watcher where id = 1;
    if not set_watcher_is_armed() then
        return new;
    end if;
    insert into sets (occurred_at, exercise, weight_lbs, reps)
    values (
        -- local wall clock, matching helpers.toEastern()
        to_char(new.occurred_at at time zone 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS'),
        w.exercise, w.weight_lbs, coalesce(new.corrected_reps, new.reps))
    returning id into new_id;
    update workset_reports set set_id = new_id where id = new.id;
    update set_watcher set last_set_at = new.occurred_at where id = 1;
    return new;
end $$;

-- repair anything already written in the wrong shape
update sets
   set occurred_at = to_char(
        (occurred_at::timestamptz at time zone 'America/New_York'), 'YYYY-MM-DD"T"HH24:MI:SS')
 where occurred_at like '% %';
