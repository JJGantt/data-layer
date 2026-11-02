-- Where the user was when speaking, as the capturing device reported it: {lat, lon, acc} (acc in metres),
-- plus `place` when the device could name it on its own (the watch geocodes on-device). The hub stores
-- what it is given and calls no geocoder itself, so a command does not send the position anywhere.
-- The voice worker offers it to the model as context for requests that depend on location.
alter table public.voice_requests add column if not exists location jsonb;
