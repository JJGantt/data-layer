-- Row Level Security on every life-data table, with no policies.
--
-- Supabase creates a table from a SQL migration with RLS off, and the anon and
-- authenticated roles hold default SELECT/write grants, so a table without RLS
-- is readable and writable through PostgREST with the anon key.
--
-- Every legitimate accessor (data-layer client, status-hub server, surf-report)
-- uses the service_role key, which BYPASSES RLS. RLS with NO policies therefore
-- leaves service_role full access and denies anon/authenticated. The
-- voice-pipeline tables with their own anon policies (voice_requests,
-- voice_presence) are not in this list; their access is set where they are
-- created.
--
-- `enable row level security` is idempotent, so re-running is safe.

alter table public.app_config          enable row level security;
alter table public.app_content         enable row level security;
alter table public.app_logs            enable row level security;
alter table public.bottle_areas        enable row level security;
alter table public.bottles             enable row level security;
alter table public.cocktails           enable row level security;
alter table public.device_status       enable row level security;
alter table public.device_tokens       enable row level security;
alter table public.exercise_catalog    enable row level security;
alter table public.exercise_muscles    enable row level security;
alter table public.exercise_sets       enable row level security;
alter table public.exercises           enable row level security;
alter table public.feeder_commands     enable row level security;
alter table public.glossary            enable row level security;
alter table public.group_descriptions  enable row level security;
alter table public.health_profile      enable row level security;
alter table public.list_items          enable row level security;
alter table public.lists               enable row level security;
alter table public.menu_dishes         enable row level security;
alter table public.notes               enable row level security;
alter table public.notifications       enable row level security;
alter table public.nutrition_audit     enable row level security;
alter table public.nutrition_entries   enable row level security;
alter table public.nutrition_targets   enable row level security;
alter table public.pairings            enable row level security;
alter table public.recipe_ingredients  enable row level security;
alter table public.recipe_steps        enable row level security;
alter table public.recipe_tags         enable row level security;
alter table public.recipes             enable row level security;
alter table public.reminders           enable row level security;
alter table public.restock_items       enable row level security;
alter table public.section_views       enable row level security;
alter table public.sets                enable row level security;
alter table public.spirit_types        enable row level security;
alter table public.style_pairings      enable row level security;
alter table public.surf_snapshots      enable row level security;
alter table public.weight_log          enable row level security;
alter table public.workout_sessions    enable row level security;
