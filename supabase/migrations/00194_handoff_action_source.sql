-- Which device sent each handoff action (status-hub routes/handoffs.js stores the request's user agent),
-- so an action nobody remembers sending (a Done he did not press) can be traced to the phone or the watch.
alter table public.handoff_actions add column if not exists source text;
