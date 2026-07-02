-- Command lifecycle now starts at CAPTURE-ACCEPT, not at enqueue: the capturer inserts the row with
-- status='transcribing' the moment a confirmed capture closes (this is what turns the working
-- indicators on — ESP blink + floor lamp amber), then fills in transcript + status='pending' when
-- STT returns. A row mid-transcription genuinely has no transcript yet.
alter table voice_requests alter column transcript drop not null;
