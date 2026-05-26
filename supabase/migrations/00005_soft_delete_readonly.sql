-- Soft delete + readonly flags on products.
-- All existing wines are marked readonly so the AI can't delete or rename them
-- (locations remain editable). Future AI-added products are read+write by default.

ALTER TABLE wines ADD COLUMN deleted  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE wines ADD COLUMN readonly BOOLEAN NOT NULL DEFAULT false;

UPDATE wines SET readonly = true WHERE kind = 'wine';
