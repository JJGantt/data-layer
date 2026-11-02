-- The restaurant app's restock list empties itself at 6am Jacksonville time every day. 6am rather than
-- midnight because a closing shift still uses the list past midnight.
--
-- pg_cron runs in UTC and 6am Eastern is 10:00 UTC in summer and 11:00 UTC in winter, so the job fires
-- at both and the delete only acts in the run where it is 6am in America/New_York. Scheduling a single
-- UTC hour would drift an hour twice a year.

create extension if not exists pg_cron;

select cron.schedule(
  'menu-restock-clear',
  '0 10,11 * * *',
  $$delete from public.restock_items
    where extract(hour from now() at time zone 'America/New_York') = 6$$
);
