-- The building has three ButterflyMX doors, each opened by its own shortcut on his phone ("Unlock Main
-- Entrance", "Unlock North Entrance", "Unlock South Entrance"). A race names the door; every path's
-- message carries it (`open-lobby-7731 <door> <nonce> <path>`) and his phone's automation runs that
-- door's shortcut.
alter table lobby_races add column door text not null default 'main' check (door in ('main', 'north', 'south'));
