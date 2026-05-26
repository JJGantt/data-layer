-- Generic restock list — wines today, sodas/liquors later.

CREATE TABLE restock_items (
    product_id    TEXT    PRIMARY KEY,
    product_kind  TEXT    NOT NULL DEFAULT 'wine',
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    added_at      TEXT    NOT NULL DEFAULT to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS')
);
