-- CONTRACT half of 00085. Recurrence is materialised rows now (see that migration for why); this
-- removes the column the old scheduler drove. Safe only once the hub that selects `repeat_every`
-- has been redeployed — PostgREST errors on a missing column, so running this early takes out every
-- list surface at once.
alter table list_items drop column if exists repeat_every;
