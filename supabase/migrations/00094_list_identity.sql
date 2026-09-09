-- Give a list an IDENTITY separate from its name, and make items reference that.
--
-- `lists.name` was the primary key, so the name was the identity and every write named a list with a
-- free string. That is what made forking possible: `add_to_list` could not tell "add this to grocery"
-- from "start a list called groceries", because both arrive as a string that is not in the table, and
-- the only way to honour the second was to create on any miss. No tool description fixes that — the
-- request cannot express the difference, so the server was guessing, and it guessed "create" every
-- time.
--
-- With an id, the two intents become two different calls against two different columns: `add_to_list`
-- takes an id that must already exist, and `create_list` is the only thing that mints one. A typo is
-- then a value not in the set, which is rejectable, rather than a new row.
--
-- The ids are readable on purpose ('l_grocery', not a uuid). They go in an `enum` on the tool schema,
-- where a model has to pick one, and an opaque key would make that choice unverifiable — it could not
-- tell which id was the grocery list without a second lookup. They are still IDS: assigned once and
-- never recomputed, so renaming a list leaves every item pointing at the same row.
--
-- EXPAND half. `list_name` stays and stays correct, because the hub reads it on every list surface and
-- writes it directly to PostgREST — it is DERIVED from `list_id` by trigger from here on, exactly as
-- `sets.exercise` is derived from `exercise_id` (00075), so the two cannot disagree.

-- ---------------------------------------------------------------------------
-- 1. lists.id
-- ---------------------------------------------------------------------------
alter table lists add column if not exists id text;

-- Slug of the name, deduped. Only ever runs for rows that predate the column; `create_list` assigns
-- every id after this.
with slugged as (
  select name,
         'l_' || trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))) as base,
         row_number() over (
           partition by 'l_' || trim(both '-' from lower(regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g')))
           order by created, name) as n
    from lists
   where id is null
)
update lists l set id = case when s.n = 1 then s.base else s.base || '-' || s.n end
  from slugged s where l.name = s.name;

alter table lists alter column id set not null;
alter table lists drop constraint if exists lists_id_uk;
alter table lists add constraint lists_id_uk unique (id);

-- ---------------------------------------------------------------------------
-- 2. list_items.list_id, and the key moves onto it
-- ---------------------------------------------------------------------------
alter table list_items add column if not exists list_id text;
update list_items i set list_id = l.id from lists l where i.list_name = l.name and i.list_id is null;
alter table list_items alter column list_id set not null;

-- The old FK pinned items to a MUTABLE key. Dropping it is what allows a rename to be a rename
-- instead of a re-parenting of every row.
alter table list_items drop constraint if exists list_items_list_name_fkey;
alter table list_items drop constraint if exists list_items_list_id_fkey;
alter table list_items add constraint list_items_list_id_fkey
  foreign key (list_id) references lists(id) on update cascade;

create index if not exists list_items_list_id_idx on list_items(list_id);

-- lists.id becomes the primary key; the name stays unique, because a second list called 'grocery'
-- is still a mistake even when it has its own id.
alter table lists drop constraint if exists lists_pkey;
alter table lists add primary key (id);
alter table lists drop constraint if exists lists_name_uk;
alter table lists add constraint lists_name_uk unique (name);

-- ---------------------------------------------------------------------------
-- 3. keep list_name derived, and accept legacy writers
-- ---------------------------------------------------------------------------
-- Two directions, because two kinds of writer exist during the expand window:
--   list_id given    → list_name is filled from it. The id wins; the name is a copy.
--   only list_name   → resolved to an id, or the write RAISES. This is where the hub's writes land
--                      until it is redeployed, and raising is the point: an unknown name used to
--                      create a list, and now it is an error with nowhere to silently go.
create or replace function list_items_resolve_list() returns trigger as $$
declare resolved text;
begin
  if new.list_id is not null then
    select name into resolved from lists where id = new.list_id;
    if resolved is null then
      raise exception 'no list with id %', new.list_id using errcode = 'foreign_key_violation';
    end if;
    new.list_name := resolved;
  elsif new.list_name is not null then
    select id into resolved from lists where name = new.list_name;
    if resolved is null then
      raise exception 'no list named %', new.list_name using errcode = 'foreign_key_violation';
    end if;
    new.list_id := resolved;
  else
    raise exception 'list_items needs list_id' using errcode = 'not_null_violation';
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists list_items_resolve_list_trg on list_items;
create trigger list_items_resolve_list_trg
  before insert or update of list_id, list_name on list_items
  for each row execute function list_items_resolve_list();

-- A rename has to reach the items' derived copy. The FK's ON UPDATE CASCADE covers the id (which
-- does not change); this covers the name (which does).
create or replace function lists_rename_propagate() returns trigger as $$
begin
  if new.name is distinct from old.name then
    update list_items set list_name = new.name where list_id = new.id;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists lists_rename_propagate_trg on lists;
create trigger lists_rename_propagate_trg
  after update on lists
  for each row execute function lists_rename_propagate();
