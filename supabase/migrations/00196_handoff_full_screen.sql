-- Handoffs: the phone shows the whole screen framed on the part that matters (pinch to see the rest),
-- and the session can offer values he will type.
alter table public.handoffs add column if not exists full_image text;   -- the whole screen; `image` is the focus alone, for the watch
alter table public.handoffs add column if not exists focus jsonb;       -- the part that matters, as fractions of full_image
alter table public.handoffs add column if not exists suggest jsonb;     -- [{label, text}] to fill his text box; cleared when it ends
alter table public.handoff_actions add column if not exists "full" boolean not null default false;  -- a tap measured on full_image, not image
