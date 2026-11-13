-- A per-day manual calorie goal. The hub rewrites each day's nutrition_targets row from its adaptive
-- maintenance estimate; a row with override=true is left alone for that day, and its calories are the
-- goal every surface shows. It applies to its own date only: the hub's goal resolver never carries an
-- override row forward to a later day, and the estimator reads weigh-ins and intake, never targets,
-- so an override cannot feed back into the computed goal.
alter table public.nutrition_targets add column if not exists override boolean not null default false;
