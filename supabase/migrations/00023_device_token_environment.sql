-- Each APNs device token belongs to exactly one push environment, decided by how the app was
-- signed: a development (Xcode) build yields a sandbox token; a TestFlight/App Store build yields a
-- production token. The sender must hit the matching gateway, so the app reports its environment and
-- we store it here (default 'sandbox' — the only tokens that exist so far are from dev builds).
alter table device_tokens add column if not exists environment text not null default 'sandbox';

notify pgrst, 'reload schema';
