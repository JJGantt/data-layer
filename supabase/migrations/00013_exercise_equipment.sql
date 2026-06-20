-- Equipment flags per catalog exercise. Drives the hub's exercise "variants" → YouTube how-to links.
-- A variant name is "{Implement} {Base}" (e.g. "Dumbbell Shoulder Press"), except bodyweight (base only)
-- and bases that already name the implement (e.g. "Ring-Assisted Squats").
alter table exercise_catalog add column if not exists equipment text[] not null default '{}';

-- Backfill the existing 26 exercises (Jared uses only dumbbells + gymnastic rings; rest are bodyweight).
update exercise_catalog set equipment = '{rings}'      where name in ('Rows','Face Pulls','Ring-Assisted Squats','Pull-Ups');
update exercise_catalog set equipment = '{bodyweight}' where name in ('Push-Ups','Supermans','Leg Raises','Back Extensions');
update exercise_catalog set equipment = '{dumbbell}'   where name in (
  'Calf Raises','Chest Fly','Chest Press','Curls','Glute Bridges','Hammer Curls','Incline Curls',
  'Incline Press','Lateral Raises','Lunges','Overhead Tricep Extension','Reverse Lunges',
  'Romanian Deadlifts','Shoulder Press','Shrugs','Side Bends','Skull Crushers','Squats');
