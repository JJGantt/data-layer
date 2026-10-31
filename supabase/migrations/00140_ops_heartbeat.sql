-- The database's own heartbeat to the ops responder (health/responder/README.md). Sent from inside
-- Postgres, so it stops exactly when Postgres stops: that silence is how a dead database is noticed.
-- The responder's token is the vault secret `ops_token` (written by health/responder/bin/setup-fly.sh),
-- never in git.
create extension if not exists pg_net;

select cron.schedule('ops-heartbeat', '* * * * *', $$
  select net.http_post(
    url := 'https://ops-responder.fly.dev/beat',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'ops_token'), '')),
    body := jsonb_build_object('machine', 'supabase', 'service', 'postgres', 'every_s', 60)
  )
$$);

-- pg_cron records every run; a job every minute is 1,440 rows a day that nothing reads.
select cron.schedule('cron-history-trim', '17 4 * * *', $$
  delete from cron.job_run_details where end_time < now() - interval '2 days'
$$);
