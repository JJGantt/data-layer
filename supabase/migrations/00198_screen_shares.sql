-- LIVE SCREEN SHARES: the Mac's whole screen streamed to the phone over WebRTC, with his taps and typing
-- sent back (status-hub docs/SCREEN.md). This table is only the signaling and the record: the phone's
-- offer goes in through the hub (routes/screenshare.js), the Mac's screen agent (src/screenAgent.ts)
-- claims the row and writes the answer, and the media then flows peer to peer or through the TURN relay.
create table if not exists public.screen_shares (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  target        text not null default 'mac' check (target in ('mac')),
  session       text,                       -- desk_sessions.id the share was opened from, when there is one
  handoff       uuid,                       -- the handoff it stands in for, when there is one
  offer         text not null,              -- the phone's SDP, ICE already gathered
  ice           jsonb,                      -- the ICE servers (TURN credentials) for the Mac's side
  answer        text,                       -- the Mac's SDP
  status        text not null default 'new' check (status in ('new', 'answered', 'live', 'ended', 'failed')),
  path          text,                       -- how the media went: host, srflx, prflx or relay
  first_frame_ms integer,                   -- capture start to the first frame encoded
  connect_ms    integer,                    -- row inserted to the connection up
  ended_reason  text,
  error         text,
  stats         jsonb,                      -- the Mac's sending counters at the end, and the phone's receiving ones
  source        text,                       -- the device that asked (user agent)
  claimed_by    text
);
create index if not exists screen_shares_created on public.screen_shares (created_at desc);
alter table public.screen_shares enable row level security;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'screen_shares') then
    execute 'alter publication supabase_realtime add table public.screen_shares';
  end if;
end $$;
