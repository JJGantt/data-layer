-- A free-text note on a set: the detail the exercise and load cannot carry — a grip, a stance, a
-- tempo, how it felt. Per SET rather than per exercise, because it is a fact about that set (one
-- pull-up set overhand, the next neutral) and the catalog entry is shared by every set ever logged.
-- NULL means no note.
ALTER TABLE sets ADD COLUMN IF NOT EXISTS note TEXT;
