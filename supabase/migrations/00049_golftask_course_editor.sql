-- Curated golf-course data, edited in the hub's course editor.
--
-- Imported from OpenStreetMap, then hand-cleaned: extraneous polygons removed,
-- tee boxes grouped by tee set, hole numbers assigned. `golftask_features` holds
-- the cleaned greens and tees, unlabelled; `golftask_holes` holds the hole
-- numbering and the scorecard.

create table if not exists golftask_courses (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    osm_bbox jsonb,                      -- [south, west, north, east]
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists golftask_features (
    id uuid primary key default gen_random_uuid(),
    course_id uuid not null references golftask_courses(id) on delete cascade,
    kind text not null check (kind in ('green', 'tee')),
    hole_number int,                     -- null until assigned
    tee_group text,                      -- tee set: 'blue', 'white', 'red', ...
    polygon jsonb not null,              -- [[lat, lon], ...]
    centroid jsonb,                      -- [lat, lon]
    source text not null default 'osm',  -- 'osm' | 'manual'
    osm_id bigint,
    deleted boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists idx_gtf_course on golftask_features(course_id)
    where deleted = false;
create index if not exists idx_gtf_hole on golftask_features(course_id, hole_number);

-- Hole numbering + scorecard, one row per (hole, tee set).
create table if not exists golftask_holes (
    id uuid primary key default gen_random_uuid(),
    course_id uuid not null references golftask_courses(id) on delete cascade,
    hole_number int not null,
    tee_group text not null default 'default',
    par int,
    handicap int,
    yardage int,                         -- scorecard playing-line distance
    centerline jsonb,                    -- OSM golf=hole geometry
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (course_id, hole_number, tee_group)
);

create index if not exists idx_gth_course on golftask_holes(course_id);

alter table golftask_courses  enable row level security;
alter table golftask_features enable row level security;
alter table golftask_holes    enable row level security;

-- Authoring tooling runs with the service role, which bypasses RLS. These
-- policies exist so the tables are not silently unreadable if that changes.
do $$
begin
    if not exists (select 1 from pg_policies
                   where tablename = 'golftask_courses' and policyname = 'gtc_all') then
        create policy gtc_all on golftask_courses for all to authenticated
            using (true) with check (true);
    end if;
    if not exists (select 1 from pg_policies
                   where tablename = 'golftask_features' and policyname = 'gtf_all') then
        create policy gtf_all on golftask_features for all to authenticated
            using (true) with check (true);
    end if;
    if not exists (select 1 from pg_policies
                   where tablename = 'golftask_holes' and policyname = 'gth_all') then
        create policy gth_all on golftask_holes for all to authenticated
            using (true) with check (true);
    end if;
end $$;
