-- Set watcher: the watch reports rep counts, and they land as real logged sets.
--
-- The watch stays dumb. It knows how many reps happened and when, and nothing about
-- exercises or weight — those are ARMED separately ("set the set watcher to chest
-- presses at 80 pounds") and applied here. Arming and reporting are fully decoupled,
-- so no LLM sits in the loop: a set that arrives while the watcher is armed becomes a
-- row in `sets` by trigger, immediately.

-- ---------------------------------------------------------------- the armed state
create table if not exists set_watcher (
    id          integer primary key default 1 check (id = 1),   -- single row
    exercise    text,
    weight_lbs  real,
    armed_at    timestamptz,
    last_set_at timestamptz,
    constraint one_row check (id = 1)
);
insert into set_watcher (id) values (1) on conflict (id) do nothing;

-- Armed means: an exercise is set AND something has happened recently. Ten minutes
-- with no set disarms it, so a forgotten watcher cannot capture tomorrow's arm swing
-- as an Incline Press. Deliberately evaluated at read time rather than by a timer —
-- there is no job to miss.
create or replace function set_watcher_is_armed() returns boolean
language sql stable as $$
    select w.exercise is not null
       and coalesce(w.last_set_at, w.armed_at) > now() - interval '10 minutes'
    from set_watcher w where w.id = 1
$$;

-- ------------------------------------------------------- what the watch reports
create table if not exists workset_reports (
    id           bigserial primary key,
    occurred_at  timestamptz not null default now(),
    reps         integer not null check (reps > 0),
    -- amended by the watch's +/- buttons; null means "as originally reported"
    corrected_reps integer check (corrected_reps > 0),
    -- the watch's X button; the logged set is removed but the report is kept, so the
    -- algorithm's original verdict survives for analysis
    deleted      boolean not null default false,
    session      text,
    algorithm    text,
    -- the row this became in `sets`, null when it arrived unarmed
    set_id       bigint references sets(id) on delete set null
);
create index if not exists workset_reports_recent on workset_reports (occurred_at desc);

-- ------------------------------------------------------------------- the trigger
-- A reported set becomes a logged set, if and only if the watcher was armed BEFORE
-- it arrived. An unarmed report is still stored — it just does not become training
-- data, which keeps the history clean without losing the observation.
create or replace function workset_report_to_set() returns trigger
language plpgsql security definer set search_path = public as $$
declare
    w set_watcher%rowtype;
    new_id bigint;
begin
    select * into w from set_watcher where id = 1;
    if not set_watcher_is_armed() then
        return new;
    end if;
    insert into sets (occurred_at, exercise, weight_lbs, reps)
    values (new.occurred_at, w.exercise, w.weight_lbs, coalesce(new.corrected_reps, new.reps))
    returning id into new_id;
    update workset_reports set set_id = new_id where id = new.id;
    update set_watcher set last_set_at = new.occurred_at where id = 1;
    return new;
end $$;

drop trigger if exists workset_report_insert on workset_reports;
create trigger workset_report_insert after insert on workset_reports
    for each row execute function workset_report_to_set();

-- The watch's edit buttons act on the REPORT, never on `sets` directly, so the key
-- shipped in the app can only amend what that app itself reported.
create or replace function workset_report_amend() returns trigger
language plpgsql security definer set search_path = public as $$
begin
    if new.set_id is null then return new; end if;
    if new.deleted and not old.deleted then
        delete from sets where id = new.set_id;
    elsif new.corrected_reps is distinct from old.corrected_reps and not new.deleted then
        update sets set reps = coalesce(new.corrected_reps, new.reps) where id = new.set_id;
    end if;
    return new;
end $$;

drop trigger if exists workset_report_update on workset_reports;
create trigger workset_report_update after update on workset_reports
    for each row execute function workset_report_amend();

-- ------------------------------------------------------------------------- access
-- The watch ships a publishable key, so it acts as anon. It may report a set, and
-- amend a report it made in the last two hours. It cannot read or touch `sets`
-- directly, and it cannot arm the watcher — arming is a deliberate act from the
-- phone or a Claude session, never something the watch can do by itself.
alter table workset_reports enable row level security;
alter table set_watcher enable row level security;

drop policy if exists workset_reports_insert_anon on workset_reports;
create policy workset_reports_insert_anon on workset_reports
    for insert to anon with check (true);

drop policy if exists workset_reports_select_anon on workset_reports;
create policy workset_reports_select_anon on workset_reports
    for select to anon using (occurred_at > now() - interval '2 hours');

drop policy if exists workset_reports_update_anon on workset_reports;
create policy workset_reports_update_anon on workset_reports
    for update to anon
    using (occurred_at > now() - interval '2 hours')
    with check (occurred_at > now() - interval '2 hours');

-- the watch may READ the watcher so it can show what it is armed to, but not set it
drop policy if exists set_watcher_select_anon on set_watcher;
create policy set_watcher_select_anon on set_watcher
    for select to anon using (true);
