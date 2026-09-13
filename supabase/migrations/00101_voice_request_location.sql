-- Where Jared was when he spoke, as the capturing device reported it: {lat, lon, acc} (acc in metres),
-- plus `place` when the device could name it on its own (the watch geocodes on-device). The hub stores
-- what it is given and calls no geocoder itself, so a command does not send his position anywhere.
-- The voice worker offers it to the model as context for requests that depend on where he is.
alter table public.voice_requests add column if not exists location jsonb;
