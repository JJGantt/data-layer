-- Collapse "done" and "deleted" into ONE state on reminders and list_items.
--
-- They modelled the same intent: the thing has been dealt with and should leave the list. Keeping
-- both meant two flags to hold in sync and, worse, two surfaces that disagreed — the voice tools
-- rendered a done item as "[x] milk", still listed, while the hub filtered it out entirely. Same
-- flag, opposite meaning depending on where you looked.
--
-- `deleted` survives; it is SOFT, so a cleared row stays recoverable and is purged by the hub after
-- a retention window. Anything previously marked done is now simply cleared.

update reminders   set deleted = true where done is true and deleted is false;
update list_items  set deleted = true where done is true and deleted is false;

alter table reminders  drop column if exists done;
alter table list_items drop column if exists done;
