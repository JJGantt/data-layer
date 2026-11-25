-- Audio recordings attached to a list item (a song idea played into the phone or watch, a voice memo).
-- Each element of `recordings` is {path, type, dur, at, request_id}: the object name in the private
-- `list-audio` bucket, its content type, its length in seconds, when it was saved (local wall clock) and
-- the voice request it was cut from. The hub writes them (status-hub /api/list-recordings) and plays them
-- back. The bucket is separate from `voice-clips` on purpose: pi-desk's retention sweep empties that one
-- after KEEP_REQUEST_DAYS, and a saved recording is kept for as long as its item.
alter table public.list_items add column if not exists recordings jsonb not null default '[]'::jsonb;

insert into storage.buckets (id, name, public)
values ('list-audio', 'list-audio', false)
on conflict (id) do nothing;

-- Append one recording in a single statement, so two saves to the same item cannot overwrite each other.
-- Returns the item's whole list after the append; no row means no such (undeleted) item.
create or replace function public.append_list_recording(p_item text, p_rec jsonb, p_updated text)
returns jsonb
language sql
as $$
  update public.list_items
     set recordings = coalesce(recordings, '[]'::jsonb) || jsonb_build_array(p_rec),
         updated = p_updated
   where id::text = p_item and deleted = false
  returning recordings;
$$;

revoke all on function public.append_list_recording(text, jsonb, text) from public, anon, authenticated;
