-- Generalize wines table to hold any product kind (wine, liquor, ...).
-- Keeping the table name `wines` for backward compat — semantically it's now `products`.

ALTER TABLE wines ADD COLUMN kind TEXT NOT NULL DEFAULT 'wine';
ALTER TABLE wines ADD COLUMN name TEXT;

-- Restock items: store a human-readable name for free-text entries (sodas, oranges, etc).
ALTER TABLE restock_items ADD COLUMN name TEXT;
