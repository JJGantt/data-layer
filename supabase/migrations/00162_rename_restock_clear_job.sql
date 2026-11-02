-- The restock-clear job's name follows the app's (00121).
do $$
begin
  if exists (select 1 from cron.job where jobname = 'capital-grille-restock-clear') then
    perform cron.unschedule('capital-grille-restock-clear');
  end if;
end $$;

select cron.schedule(
  'menu-restock-clear',
  '0 10,11 * * *',
  $$delete from public.restock_items
    where extract(hour from now() at time zone 'America/New_York') = 6$$
);
