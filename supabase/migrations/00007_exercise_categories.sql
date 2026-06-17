-- Categories move to the exercise level (a required set), session type becomes derived.
alter table exercises add column if not exists categories text[];

update exercises set categories = (case
  when lower(trim(name)) in ('dumbbell press','dumbbell flyes','dumbbell chest fly','incline press','incline dumbbell press','shoulder press','dumbbell shoulder press','lateral raises','overhead tricep extension','skull crushers','push-ups','push ups') then array['push']
  when lower(trim(name)) in ('pull-ups','rows','ring rows','face pulls','ring face pulls','curls','dumbbell curls','hammer curls','incline curls','incline dumbbell curls','shrugs','dumbbell shrugs') then array['pull']
  when lower(trim(name)) in ('squat','squats','squats (dumbbell)','dumbbell squats','ring-assisted squats','lunges','reverse lunge','reverse lunges','glute bridges','calf raises') then array['legs']
  when lower(trim(name)) in ('leg raises','dumbbell side bends') then array['core']
  when lower(trim(name)) in ('romanian deadlift','romanian deadlifts') then array['pull','legs']
  else null end)
where categories is null;

-- guard: fail loudly if anything went unmapped (so we never silently miscategorize)
do $$ begin
  if exists (select 1 from exercises where categories is null) then
    raise exception 'Unmapped exercises remain — aborting';
  end if;
end $$;

alter table exercises
  add constraint exercises_categories_valid
  check (categories <@ array['push','pull','legs','core','cardio'] and array_length(categories,1) >= 1);
alter table exercises alter column categories set not null;

-- session type is now fully derived from its exercises
alter table workout_sessions drop column if exists type;
alter table workout_sessions drop column if exists categories;
