-- kind 'start': his phone's automation began (its first step reports, before the door's unlock
-- shortcut), at most once per path per race. With 'arrive' (reported after the unlock) it splits a
-- race's delay into delivery + automation start, and the unlock itself.
alter table lobby_events drop constraint lobby_events_kind_check;
alter table lobby_events add constraint lobby_events_kind_check check (kind in ('send', 'arrive', 'start'));
create unique index lobby_events_one_start on lobby_events (race_id, path) where kind = 'start';
