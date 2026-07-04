-- The requesting device's own current wall clock (naive, no offset — "YYYY-MM-DDTHH:MM:SS"), captured
-- at the moment a phone/web request is made. Lets the worker tell the model "this is truly now, wherever
-- you are" instead of defaulting to the worker machine's own clock (which is only correct when the
-- request actually originated at home, e.g. the ESP puck).
alter table voice_requests add column if not exists client_now text;
