-- The status-hub server caches its dashboard source rows and invalidates on realtime events, so
-- every table it renders must be in the realtime publication. These five were missing — without
-- them an edit would sit invisible until the cache's 15-minute reconciliation backstop.
alter publication supabase_realtime add table
  public.weight_log,
  public.nutrition_targets,
  public.exercise_catalog,
  public.exercise_muscles,
  public.surf_snapshots;
