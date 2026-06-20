-- Audit trail for hub UI write actions on nutrition_entries (add / edit / delete), so every action
-- is reversible: re-insert a deleted row from `before`, revert an edit to `before`, undo an add via
-- `after.id`. Powers a future one-tap undo and manual review/reversal.
create table if not exists nutrition_audit (
  id        uuid primary key default gen_random_uuid(),
  at        timestamptz not null default now(),
  action    text not null,          -- 'add' | 'edit' | 'delete'
  entry_id  uuid,                    -- affected nutrition_entries.id
  before    jsonb,                   -- full row snapshot before the action (null for add)
  after     jsonb                    -- full row snapshot after the action (null for delete)
);
create index if not exists nutrition_audit_at_idx on nutrition_audit (at desc);
