-- HANDOFFS ON ONE SCREEN GO ONE AT A TIME, EACH ON ITS OWN WINDOW (README § Handoffs).
--
-- `queued`: a handoff asked while another session's is open on the same screen (the Mac's display holds
-- one keyboard focus, so two asks there would take each other's typing). The agent opens it when the one in
-- front ends; nothing is pushed until then.
-- `window_id`: the Mac window (CGWindowID) the handoff is for, raised before every screenshot and input, so
-- another window of the same app coming to the front is never what he sees or types into.
-- `active_at`: activity the agent hears outside handoff_actions (it was opened from the queue, input came
-- through a live screen share), which the expiry counts like an action.
alter table public.handoffs drop constraint if exists handoffs_status_check;
alter table public.handoffs add constraint handoffs_status_check
  check (status in ('new', 'queued', 'open', 'done', 'cancelled', 'failed'));
alter table public.handoffs add column if not exists window_id bigint;
alter table public.handoffs add column if not exists active_at timestamptz;
