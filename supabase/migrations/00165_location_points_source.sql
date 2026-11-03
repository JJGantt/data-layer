-- WHAT PRODUCED EACH POINT (status-hub docs/LOCATION.md). The phone no longer streams every fix; its
-- points now come from a few distinct events, and a reader needs to know which one a row is:
--   'arrive' / 'depart'  a visit's start and end (CLVisit) at the visit's coordinate
--   'move'               a significant-change wake (~500 m moved), coarse, cell/Wi-Fi based
--   'fix'                one GPS fix taken during that wake, or when the app is opened
-- Null on rows written before this column existed (the live stream, and the watch's per-use fixes).
alter table location_points add column if not exists source text;
