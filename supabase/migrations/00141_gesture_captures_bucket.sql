-- Raw motion captures from the StatusHub watch app's gesture page, one JSON object per capture,
-- labelled with the gesture it was meant to be. They are the data for designing gestures of our own
-- (and for telling a wrist flick from a lowered wrist), so they are kept.
--
-- Private and with no anon policy: the watch never talks to storage. It uploads through the hub
-- (POST /api/gestures), which writes with the service key, and reads go through the hub too.

insert into storage.buckets (id, name, public)
values ('gesture-captures', 'gesture-captures', false)
on conflict (id) do nothing;
