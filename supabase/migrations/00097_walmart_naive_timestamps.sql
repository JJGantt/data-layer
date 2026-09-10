-- Make 00095's timestamps naive local wall-clock, like every other table here.
--
-- 00095 used timestamptz. Every writer goes through helpers.now(), which returns a NAIVE Eastern
-- string with no zone on it, so Postgres read those as UTC and stored an instant four hours off:
-- a cart observed at 8:01pm came back as 20:01+00:00, which is 4:01pm Eastern. Nothing errored.
--
-- `using <col> at time zone 'UTC'` reverses it exactly — it renders each stored instant as its UTC
-- wall clock, which is the literal string helpers.now() wrote in the first place.
--
-- The `default now()` clauses go too. On a bare timestamp column Postgres fills them from the
-- SERVER clock, which is UTC, so a row inserted without an explicit value would reintroduce the same
-- four-hour skew through a different door. Every writer passes helpers.now() instead.

alter table walmart_cart
  alter column observed_at drop default,
  alter column observed_at type timestamp using observed_at at time zone 'UTC';

alter table walmart_cart_state
  alter column observed_at type timestamp using observed_at at time zone 'UTC';

alter table walmart_orders
  alter column detected_at drop default,
  alter column detected_at type timestamp using detected_at at time zone 'UTC';

-- watch_expiration arrives from Gmail as epoch millis, a true instant; the watcher converts it to
-- Eastern wall clock on write so the health check can compare it against helpers.now() directly.
alter table gmail_watch_state
  alter column watch_expiration type timestamp using watch_expiration at time zone 'UTC',
  alter column last_renewed_at  type timestamp using last_renewed_at  at time zone 'UTC',
  alter column last_event_at    type timestamp using last_event_at    at time zone 'UTC';
