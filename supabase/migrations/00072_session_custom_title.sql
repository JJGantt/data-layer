-- The name the user chose, kept apart from the one anything else derived.
--
-- `label` collapses three sources — a name the user typed, the label the router wrote at dispatch, and
-- Claude Code's generated title — which is right for a list that wants the best available name. A
-- glanceable surface wants the opposite: a tab says the REPO unless the user has actually named that
-- session, because a generated title is long, and the router's label describes a job rather than
-- naming a thing.
alter table desk_sessions add column if not exists custom_title text;
