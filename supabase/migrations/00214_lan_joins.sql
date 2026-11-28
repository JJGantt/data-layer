-- Devices announcing themselves on the home network (data-layer presence/listener.py): every DHCP
-- message heard by a listener on the Mac or the Pi, so the phone and the watch joining the Wi-Fi can be
-- seen from the house with no app running on them. Which MAC is which device is learned from these rows
-- (iOS uses a private address per network, fixed unless set to rotate). Kept raw for now, for testing.
create table lan_joins (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  machine text not null,
  mac text not null,
  ip text,
  hostname text,
  message text,
  vendor text,
  raw text
);
create index lan_joins_at on lan_joins (at desc);
create index lan_joins_mac on lan_joins (mac, at desc);
