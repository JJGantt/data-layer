-- Tables that were made in the Supabase dashboard rather than in a migration, written down so the
-- migrations alone rebuild the schema. On the live project every statement here is a no-op: each
-- table already exists, so `create table if not exists` skips it and the guarded blocks find nothing
-- to do. On a fresh database they create what later migrations (00040, 00042, 00080, 00116, 00119,
-- 00149, ...) alter, index and grant on.
--
-- It is numbered 00009, the one unused number before the first migration that needs these tables, so
-- a fresh replay creates them in time. Being older than migrations already applied, it is pushed with
-- `supabase db push --include-all`.
--
-- Definitions are the live ones (pg_catalog, 2026-11-01) minus what a later migration adds itself:
-- policies (00116, 00149), the realtime publication (00040), surf_snapshots.run_init and its index
-- (00080), app_config.restaurant_name and menu_dishes.extra (00149). app_config is created with the
-- two backend columns that 00119 drops.

-- The restaurant inventory: 00002's `wines` and `wine_areas`, renamed in the dashboard, with the text
-- row columns replaced by integer ones and the foreign keys changed to RESTRICT.
do $$
begin
  if to_regclass('public.bottles') is null and to_regclass('public.wines') is not null then
    alter table public.wine_areas rename to bottle_areas;
    alter table public.wines rename to bottles;
    alter table public.bottles drop constraint if exists wines_primary_area_fkey;
    alter table public.bottles drop constraint if exists wines_backup_area_fkey;
    alter table public.bottles drop column primary_row;
    alter table public.bottles drop column backup_row;
  end if;
end $$;

create table if not exists public.bottle_areas (
  name    text primary key,
  created text not null default to_char((now() at time zone 'America/New_York'), 'YYYY-MM-DD"T"HH24:MI:SS')
);

create table if not exists public.bottles (
  id             text primary key,
  primary_area   text,
  primary_column integer,
  backup_area    text,
  backup_column  integer,
  updated        text not null default to_char((now() at time zone 'America/New_York'), 'YYYY-MM-DD"T"HH24:MI:SS'),
  kind           text not null default 'wine',
  name           text,
  deleted        boolean not null default false,
  readonly       boolean not null default false
);
alter table public.bottles
  add column if not exists primary_row     integer,
  add column if not exists backup_row      integer,
  add column if not exists category        text,
  add column if not exists tasting_notes   text,
  add column if not exists food_pairing    text,
  add column if not exists image_url       text,
  add column if not exists varietal        text,
  add column if not exists price           numeric,
  add column if not exists bottle_price    numeric,
  add column if not exists producer        text,
  add column if not exists producer_parent text,
  add column if not exists location        text,
  add column if not exists abv             text,
  add column if not exists grapes          text[],
  add column if not exists grape_detail    text,
  add column if not exists pairing_style   text,
  add column if not exists talking_points  text,
  add column if not exists unverified      boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bottles_primary_area_fkey') then
    alter table public.bottles add constraint bottles_primary_area_fkey
      foreign key (primary_area) references public.bottle_areas(name) on update cascade on delete restrict;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bottles_backup_area_fkey') then
    alter table public.bottles add constraint bottles_backup_area_fkey
      foreign key (backup_area) references public.bottle_areas(name) on update cascade on delete restrict;
  end if;
end $$;

-- The restaurant app's catalog and configuration.
create table if not exists public.app_config (
  profile          text primary key,
  allowed_backends text[],
  allowed_models   text[] not null,
  default_backend  text,
  default_model    text not null,
  updated_at       timestamptz not null default now()
);

create table if not exists public.app_content (
  key        text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.app_logs (
  id             uuid primary key default gen_random_uuid(),
  "timestamp"    timestamptz not null default now(),
  interaction_id uuid not null,
  session_id     text,
  backend        text,
  kind           text not null,
  tool_name      text,
  input          jsonb,
  output         text,
  error          text,
  latency_ms     integer,
  tokens_in      integer,
  tokens_out     integer,
  user_input     text,
  final_answer   text
);
create index if not exists app_logs_interaction_idx on public.app_logs (interaction_id, "timestamp");
create index if not exists app_logs_timestamp_idx on public.app_logs ("timestamp" desc);

create table if not exists public.cocktails (
  id          text primary key,
  name        text not null,
  sort        integer not null default 0,
  glass       text,
  garnish     text,
  service     text,
  ingredients jsonb,
  prep        jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.glossary (
  term       text primary key,
  definition text not null,
  aliases    text[] default '{}',
  category   text
);

create table if not exists public.group_descriptions (
  dimension   text not null,
  value       text not null,
  description text not null,
  section     text
);
create unique index if not exists group_descriptions_uniq
  on public.group_descriptions (dimension, value, coalesce(section, ''));

create table if not exists public.menu_dishes (
  id               text primary key,
  menu             text not null,
  section          text not null,
  name             text not null,
  sort             integer not null default 0,
  page             integer,
  price            integer,
  calories         integer,
  serves           integer,
  menu_name        text,
  description      text,
  image            text,
  serving_piece    text,
  production_time  text,
  station          text,
  tasting_notes    text,
  portion          jsonb,
  garnish          jsonb,
  to_bring         jsonb,
  questions_to_ask jsonb,
  notes            jsonb,
  talking_points   jsonb,
  sizes            jsonb,
  variants         jsonb,
  ingredients      jsonb,
  updated_at       timestamptz not null default now()
);

create table if not exists public.pairings (
  wine_id       text not null,
  dish_id       text not null,
  strength      text not null,
  justification text,
  primary key (wine_id, dish_id)
);
create index if not exists pairings_dish_idx on public.pairings (dish_id);

create table if not exists public.section_views (
  id          text primary key,
  section     text not null,
  label       text not null,
  group_by    text not null,
  sort_order  integer not null default 0,
  is_default  boolean not null default false,
  group_order text[]
);

create table if not exists public.spirit_types (
  varietal    text primary key,
  type        text not null,
  type_order  integer,
  style_order integer
);

create table if not exists public.style_pairings (
  dish_id          text not null,
  style            text not null,
  tier             text not null,
  justification    text not null,
  leaves_out       text,
  standout_wine_id text,
  standout_reason  text,
  sort_order       integer default 0,
  primary key (dish_id, style)
);

-- The surf forecast mirror (surf-report).
create table if not exists public.surf_snapshots (
  id          bigint generated always as identity primary key,
  captured_at timestamptz not null,
  spot_id     text not null,
  slug        text not null,
  optimal     jsonb,
  tides       jsonb,
  rows        jsonb not null,
  inserted_at timestamptz not null default now(),
  water_temp  jsonb,
  unique (spot_id, captured_at)
);
create index if not exists surf_snapshots_spot_time on public.surf_snapshots (spot_id, captured_at desc);

-- The gnl app's tables.
create table if not exists public.gnl_users (
  email         text primary key,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists public.gnl_invite_codes (
  code       text primary key,
  used_by    text,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

create table if not exists public.gnl_profile (
  user_id          text primary key default 'default',
  height_in        numeric,
  sex              text,
  birth_year       integer,
  goal_mode        text not null default 'maintain',
  protein_per_lb   numeric not null default 0.8,
  fat_per_lb       numeric not null default 0.4,
  calorie_adjust   numeric not null default 0,
  activity         text,
  updated_at       timestamptz not null default now(),
  onboarded        boolean not null default false,
  window_start_min integer,
  window_end_min   integer
);

create table if not exists public.gnl_chat (
  id         bigint generated always as identity primary key,
  user_id    text not null,
  role       text not null,
  text       text not null default '',
  source     text,
  created_at timestamptz not null default now()
);
create index if not exists gnl_chat_user on public.gnl_chat (user_id, id);

create table if not exists public.gnl_logs (
  id      bigint generated always as identity primary key,
  ts      timestamptz not null default now(),
  level   text not null default 'info',
  event   text not null,
  user_id text,
  detail  jsonb
);
create index if not exists gnl_logs_level on public.gnl_logs (level, ts desc);
create index if not exists gnl_logs_ts on public.gnl_logs (ts desc);
create index if not exists gnl_logs_user on public.gnl_logs (user_id, ts desc);

create table if not exists public.gnl_nutrition_entries (
  id          text primary key,
  user_id     text not null default 'default',
  date        text not null,
  occurred_at text not null,
  logged      text,
  name        text not null,
  quantity    numeric not null default 1,
  calories    numeric,
  protein_g   numeric,
  carbs_g     numeric,
  fat_g       numeric,
  ingredients jsonb,
  staged      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists gnl_entries_occurred on public.gnl_nutrition_entries (user_id, occurred_at);
create index if not exists gnl_entries_user_date on public.gnl_nutrition_entries (user_id, date);
create index if not exists gnl_entries_user_staged on public.gnl_nutrition_entries (user_id, staged);

create table if not exists public.gnl_nutrition_targets (
  id        bigint generated always as identity primary key,
  user_id   text not null default 'default',
  date      text not null,
  calories  numeric,
  protein_g numeric,
  carbs_g   numeric,
  fat_g     numeric,
  logged_at timestamptz not null default now()
);
create index if not exists gnl_targets_user_date on public.gnl_nutrition_targets (user_id, date);

create table if not exists public.gnl_weight_log (
  id         bigint generated always as identity primary key,
  user_id    text not null default 'default',
  date       text not null,
  weight_lbs numeric not null,
  logged     text,
  created_at timestamptz not null default now()
);
create index if not exists gnl_weight_user_date on public.gnl_weight_log (user_id, date);

-- RLS on, no policy (service key only), as on the live project; the restaurant app's policies come
-- from 00116 and 00149.
alter table public.bottle_areas          enable row level security;
alter table public.bottles               enable row level security;
alter table public.app_config            enable row level security;
alter table public.app_content           enable row level security;
alter table public.app_logs              enable row level security;
alter table public.cocktails             enable row level security;
alter table public.glossary              enable row level security;
alter table public.group_descriptions    enable row level security;
alter table public.menu_dishes           enable row level security;
alter table public.pairings              enable row level security;
alter table public.section_views         enable row level security;
alter table public.spirit_types          enable row level security;
alter table public.style_pairings        enable row level security;
alter table public.surf_snapshots        enable row level security;
alter table public.gnl_users             enable row level security;
alter table public.gnl_invite_codes      enable row level security;
alter table public.gnl_profile           enable row level security;
alter table public.gnl_chat              enable row level security;
alter table public.gnl_logs              enable row level security;
alter table public.gnl_nutrition_entries enable row level security;
alter table public.gnl_nutrition_targets enable row level security;
alter table public.gnl_weight_log        enable row level security;
