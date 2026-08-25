-- CONTRACT half of the pair started in 00056. Safe only now that the hub reading `reminders` has been
-- redeployed: 00056 was purely additive so the old code kept working in the gap, and this drop would
-- have 500'd /api/todos and errored the scheduler every 60s had it run before that deploy.
--
-- Every row was copied to `list_items` in 00056 with its id intact. Nothing reads this table any
-- more: the hub scans `list_items` for anything dated, and data-layer's reminders module is deleted.

drop table if exists reminders;
