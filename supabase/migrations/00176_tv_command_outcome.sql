-- What an `open` actually led to, written by the Pi after it has done the follow-up every open gets
-- (data-layer tvHome.ts): Prime's profile picker, Apple TV's Play button, then whether the app is
-- sending sound. Kept apart from `result`, which is the TV app's own answer and can arrive after it.
alter table tv_commands add column if not exists outcome jsonb;
alter table tv_commands add column if not exists checked_at timestamptz;
