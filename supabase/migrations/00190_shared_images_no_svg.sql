-- SVG out of shared-images: the watch cannot decode it, and an SVG can carry script. A session renders
-- one to PNG before sharing it.
update storage.buckets
set allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
where id = 'shared-images';
