-- The rep watcher names its exercise by id too.
--
-- It keeps the NAME as well, and that is not redundancy left by accident: 00046's
-- workset_report_to_set() trigger reads `w.exercise` when it turns a watch report into a set, and
-- that trigger runs in SQL where a join would have to be written by hand. The name it stores is now
-- derived from the id by setWatcher(), so the two cannot drift, and the trigger keeps working
-- untouched — the sets_resolve_exercise trigger from 00075 fills in exercise_id on the row it
-- inserts, so a watch-logged set is normalized exactly like every other one.

alter table set_watcher add column exercise_id int references exercise_catalog(id) on update cascade;
update set_watcher w set exercise_id = c.id
  from exercise_catalog c where lower(w.exercise) = lower(c.name);
