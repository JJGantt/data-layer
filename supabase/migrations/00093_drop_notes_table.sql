-- CONTRACT half of 00092. The hub no longer selects from `notes` on /api/todos (status-hub 3fc42fe,
-- deployed and verified serving before this ran), and nothing else reads the table: the data-layer
-- module, its HTTP routes and the three MCP verbs went in the same commit.
--
-- Rows were copied in 00092, not moved, so this is the point of no return for anything that survived
-- only here. Verified before writing this: the one note is on the `notes` list with its body intact.
drop table if exists notes;
