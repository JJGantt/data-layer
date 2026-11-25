-- Images a session or the voice orchestrator shows Jared: a mockup, a chart, a photo fetched for him.
-- share_image (src/images.ts) uploads with the service key; the hub serves them at /img/<name> behind
-- its login, which is how the phone and the watch render them inline in a reply.
--
-- Private and with no anon policy: nothing reads storage directly. Kept, not swept — an image is part
-- of a reply he may scroll back to.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shared-images', 'shared-images', false, 15728640,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'])
on conflict (id) do nothing;
