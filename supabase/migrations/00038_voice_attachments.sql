-- Photo mode: voice_requests carry attached photos (array of storage object paths in the private
-- voice-attachments bucket); the worker copies them onto the user's voice_messages row so the chat
-- renders thumbnails, and stamps which worker (mac/pi/fly) produced each reply.
alter table voice_requests add column if not exists attachments jsonb;
alter table voice_messages add column if not exists attachments jsonb;
alter table voice_messages add column if not exists worker text;
