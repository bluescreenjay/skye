-- AI Browser 004 schema: AI clustering
-- Source: specs/004-ai-clustering/data-model.md
--
-- Requires 001_init.sql first. Safe to run more than once (IF NOT EXISTS
-- everywhere, and the backfill only touches rows that still need it).
--
-- Adds:
--   tab_refs.placement_source   who placed a tab: 'ai' | 'user' | NULL (never placed)
--   cluster_runs                one clustering execution per row; the unit a user can undo
--   cluster_run_moves           the undo log: every tab a run moved
--   suggestions                 stored proposals the user can accept or ignore
--
-- Same integrity rule as 001: a child row's user_id must match its parent's
-- user_id, enforced with composite foreign keys onto (id, user_id).
-- The two UUID[] columns (suggestions.tab_ref_ids, cluster_runs.created_workspace_ids)
-- have no per-element foreign key; every query that expands them joins on
-- (id, user_id) so a foreign or missing id can never surface.

-- NULL = never placed. 'user' = the user placed it, including deliberately leaving
-- it in Other. 'ai' = a clustering run placed it. The CHECK is part of the
-- ADD COLUMN, so it is skipped together with the column on a re-run.
ALTER TABLE tab_refs
  ADD COLUMN IF NOT EXISTS placement_source TEXT
    CHECK (placement_source IN ('ai', 'user'));

-- Before this feature every assignment was manual, so a tab already in a workspace
-- was placed by the user. Re-running is harmless: only rows with a workspace and
-- no recorded origin are touched (an undo resets workspace_id too).
UPDATE tab_refs
  SET placement_source = 'user'
  WHERE workspace_id IS NOT NULL AND placement_source IS NULL;

CREATE TABLE IF NOT EXISTS cluster_runs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status TEXT NOT NULL
    CHECK (status IN ('running', 'succeeded', 'failed', 'undone')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  considered_count INTEGER NOT NULL DEFAULT 0,
  left_out_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  suggestion_count INTEGER NOT NULL DEFAULT 0,
  discarded_count INTEGER NOT NULL DEFAULT 0,
  -- The state the run started from, and the state after its changes. A new run
  -- compares its own starting state with the latest settled one to skip when
  -- nothing changed.
  input_fingerprint TEXT,
  settled_fingerprint TEXT,
  created_workspace_ids UUID[] NOT NULL DEFAULT '{}',
  -- Generic failure text. Never page content or model output.
  error TEXT,
  undone_at TIMESTAMPTZ,
  -- Target for the composite foreign keys below.
  UNIQUE (id, user_id)
);

-- At most one running run per user.
CREATE UNIQUE INDEX IF NOT EXISTS cluster_runs_one_running_idx
  ON cluster_runs (user_id) WHERE status = 'running';

CREATE INDEX IF NOT EXISTS cluster_runs_user_started_idx
  ON cluster_runs (user_id, started_at DESC);

-- Only unplaced Other tabs are ever moved, so the prior state is always "Other,
-- never placed" and no "from" columns are needed.
CREATE TABLE IF NOT EXISTS cluster_run_moves (
  run_id UUID NOT NULL,
  user_id UUID NOT NULL,
  tab_ref_id UUID NOT NULL,
  to_workspace_id UUID NOT NULL,
  PRIMARY KEY (run_id, tab_ref_id),
  FOREIGN KEY (run_id, user_id)
    REFERENCES cluster_runs (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (tab_ref_id, user_id)
    REFERENCES tab_refs (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (to_workspace_id, user_id)
    REFERENCES workspaces (id, user_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS suggestions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- The run that created (or last refreshed) it.
  run_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  emoji TEXT,
  -- Set when the group belongs in an existing active workspace. NULL is not
  -- checked by the composite foreign key (MATCH SIMPLE), like tab_refs.workspace_id.
  target_workspace_id UUID,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  -- Proposed members; not mutated after insert. Readers keep only the ones that
  -- are still unplaced.
  tab_ref_ids UUID[] NOT NULL CHECK (cardinality(tab_ref_ids) >= 2),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'ignored', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (id, user_id),
  FOREIGN KEY (run_id, user_id)
    REFERENCES cluster_runs (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (target_workspace_id, user_id)
    REFERENCES workspaces (id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS suggestions_user_status_idx
  ON suggestions (user_id, status);
