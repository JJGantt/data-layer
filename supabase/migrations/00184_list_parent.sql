-- A list can sit inside another list: `lists.parent_id`, null for a top-level list.
--
-- Only lists nest, never items: an item still belongs to exactly one list by `list_items.list_id`, so
-- everything that reads items (scoring, the due view, the calendar) is untouched by the tree.
--
-- Deleting a parent is RESTRICTed here rather than cascaded or nulled: `removeList` in lists.ts moves
-- the children up to the deleted list's own parent first, and a delete that skips that step should fail
-- rather than silently take sublists with it or drop them to the top level.
alter table lists add column if not exists parent_id text
  references lists(id) on update cascade on delete restrict;
create index if not exists lists_parent_id_idx on lists(parent_id);

-- No list may be its own ancestor. Walked on every write that sets a parent, so a cycle can never be
-- stored however the write arrives (the MCP, the HTTP API, PostgREST directly).
create or replace function lists_no_cycle() returns trigger as $$
declare cur text := new.parent_id; depth int := 0;
begin
  while cur is not null loop
    if cur = new.id then
      raise exception 'list % cannot be nested inside itself or one of its own sublists', new.id;
    end if;
    depth := depth + 1;
    if depth > 64 then raise exception 'list nesting is too deep'; end if;
    select parent_id into cur from lists where id = cur;
  end loop;
  return new;
end $$ language plpgsql;

drop trigger if exists lists_no_cycle on lists;
create trigger lists_no_cycle before insert or update of parent_id on lists
  for each row when (new.parent_id is not null) execute function lists_no_cycle();
