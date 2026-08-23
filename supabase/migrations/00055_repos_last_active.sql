-- The hub's repo picker lists DIRECTORIES, not just git checkouts.
--
-- Filtering to `.git` hid some of the most active work on the Mac: several large working directories
-- are deliberately not repos, and neither are several research/scratch projects — but they're exactly what you'd want to open a session in from the phone. Git-ness is
-- decoration now (branch + dirty when present), not the entry condition.
--
-- So the sort column can no longer be "the HEAD commit date": for a non-repo it's the directory's
-- own mtime. Same meaning either way — when was this last touched.

alter table public.repos rename column last_commit to last_active;
