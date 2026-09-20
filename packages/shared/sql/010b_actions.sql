-- AI Browser 010b schema: action tools (MCP and local)
-- Source: specs/010b-mcp-action-tools/data-model.md
--
-- Requires 001_init.sql first. Safe to run more than once.
--
-- One table: workspace_notes holds the saved summary, saved search queries, and
-- saved references. Tool runs reuse action_runs (feature 001 / 010) with no new column.

CREATE TABLE IF NOT EXISTS workspace_notes (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('summary', 'query', 'ref')),
  -- summary: the text (1 to 3,000). query: the query (3 to 120). ref: the quote (10 to 300).
  body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  -- ref only: the tab's plain address (no query string or fragment). NULL otherwise.
  url          TEXT,
  -- summary only: { coverage: {tabsTotal, tabsIncluded, pagesRead}, cited: [{title,url}], unreadable: number }.
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- summary: 'current' (one row per workspace, replaced on each write).
  -- query / ref: a normalized key (lowercase, collapsed whitespace, folded quote characters; refs add the address).
  dedupe_key   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspaces (id, user_id) ON DELETE CASCADE,
  UNIQUE (user_id, workspace_id, kind, dedupe_key)
);

CREATE INDEX IF NOT EXISTS workspace_notes_workspace_kind_idx
  ON workspace_notes (user_id, workspace_id, kind, created_at, id);
