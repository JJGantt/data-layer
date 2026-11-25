-- What a handoff's screenshot shows: the relevant part of the screen, not all of it (handoff.ts).
--   app     mac-screen: the app whose front window is captured (its owner name, `hands windows`)
--   region  {x,y,w,h}, fractions of the window or page: the part that matters, e.g. a sign-in dialog
--   selector  pi-browser: a CSS selector whose element (plus a margin) is captured, followed as it moves
--   whole   Jared's toggle: true shows the whole window or page instead of the crop
alter table public.handoffs add column if not exists app text;
alter table public.handoffs add column if not exists region jsonb;
alter table public.handoffs add column if not exists selector text;
alter table public.handoffs add column if not exists whole boolean not null default false;

alter table public.handoff_actions drop constraint if exists handoff_actions_kind_check;
alter table public.handoff_actions add constraint handoff_actions_kind_check
  check (kind in ('tap', 'text', 'key', 'refresh', 'view', 'done', 'cancel'));
