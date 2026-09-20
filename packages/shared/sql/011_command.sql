-- AI Browser 011 schema: global command bar
-- Source: specs/011-global-command-bar/data-model.md
--
-- Requires 001_init.sql first. Safe to run more than once.
--
-- Adds ONE table and nothing else (no column on an existing table, no index):
--   command_undo   the single most recent change made through the command bar, one row per
--                  person, so "only the most recent change can be undone" is the table's
--                  primary key. It holds ids, counts, the old name of a rename, and a one-line
--                  summary; never a tab title, an address, or text the person typed. A row
--                  older than 10 minutes is treated as absent and deleted the next time that
--                  person reads or writes it (no sweeper).

CREATE TABLE IF NOT EXISTS command_undo (
  user_id UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  kind TEXT NOT NULL
    CHECK (kind IN ('organize', 'group', 'move', 'rename', 'merge', 'create')),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 1 AND 200),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
