-- Whether a queued dispatch asked for an HTML write-up.
--
-- Reports are opt-in per request, so the flag has to survive the wait: a job that queues behind three
-- resident sessions and launches twenty minutes later must still know it was asked for one. Storing
-- it here rather than baking the directive into `prompt` keeps the prompt exactly what Jared said,
-- which is what the sessions pane shows him.
alter table desk_queue add column if not exists report boolean not null default false;
