-- Restaurant wines: location tracking only.
-- Static wine data (tasting notes, pairings, image) lives in the iOS app bundle.

CREATE TABLE wine_areas (
    name    TEXT PRIMARY KEY,
    created TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS')
);

CREATE TABLE wines (
    id              TEXT PRIMARY KEY,
    primary_area    TEXT REFERENCES wine_areas(name) ON UPDATE CASCADE ON DELETE SET NULL,
    primary_row     TEXT CHECK (primary_row IN ('back','front','top','bottom')),
    primary_column  INTEGER,
    backup_area     TEXT REFERENCES wine_areas(name) ON UPDATE CASCADE ON DELETE SET NULL,
    backup_row      TEXT CHECK (backup_row IN ('back','front','top','bottom')),
    backup_column   INTEGER,
    updated         TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'America/New_York', 'YYYY-MM-DD"T"HH24:MI:SS')
);
