-- The elevator watch runs for as long as he is near home and records every ride, so a ride down is a row
-- too ('down', rise_m negative). 'no_ride' is no longer written.
alter table elevator_rides drop constraint elevator_rides_outcome_check;
alter table elevator_rides add constraint elevator_rides_outcome_check
  check (outcome in ('unlocked', 'already_unlocked', 'unlock_failed', 'no_exit', 'no_ride', 'down'));
