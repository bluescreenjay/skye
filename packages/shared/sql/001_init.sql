-- AI Browser 001 schema skeleton
-- Source: specs/001-shared-domain-model/contracts/001_init.sql
-- Preferred: Tiger Data / Timescale Postgres
-- Pivot: Supabase / plain Postgres. Skip the create_hypertable call below;
--        tab_events stays a regular table.
--
-- Requires PostgreSQL 15+ (ON DELETE SET NULL (column_list)). Tiger Data and
-- Supabase both meet this.
--
-- Integrity rule 1 (data-model.md): a child row's user_id must match its parent
-- workspace's user_id. Enforced with composite foreign keys onto
-- workspaces (id, user_id). workspace_id NULL means "Other" and is not checked.
-- Links from tab_events / corrections to a tab_ref are enforced the same way,
-- onto tab_refs (id, user_id). The workspace ids on tab_events and corrections
-- are history snapshots and deliberately have no foreign key.

CREATE TABLE users (
  id UUID PRIMARY KEY,
  device_token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  emoji TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'saved', 'archived')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Target for the composite foreign keys below.
  UNIQUE (id, user_id)
);

CREATE INDEX workspaces_user_id_idx ON workspaces (user_id);

-- workspace_id NULL = Other. Deleting a workspace turns its tabs into Other
-- rather than deleting them (integrity rule 4).
CREATE TABLE tab_refs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  chrome_tab_id INTEGER,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspaces (id, user_id) ON DELETE SET NULL (workspace_id),
  -- Target for the composite foreign keys on tab_events and corrections.
  UNIQUE (id, user_id)
);

CREATE INDEX tab_refs_user_workspace_idx ON tab_refs (user_id, workspace_id);

-- Append-only tab lifecycle. workspace_id is a snapshot of membership at event
-- time, so it deliberately has no foreign key: events outlive workspaces.
CREATE TABLE tab_events (
  time TIMESTAMPTZ NOT NULL,
  id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tab_ref_id UUID,
  chrome_tab_id INTEGER,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  workspace_id UUID,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('opened', 'updated', 'activated', 'closed', 'reassigned')),
  PRIMARY KEY (time, id),
  FOREIGN KEY (tab_ref_id, user_id)
    REFERENCES tab_refs (id, user_id) ON DELETE SET NULL (tab_ref_id)
);

CREATE INDEX tab_events_user_time_idx ON tab_events (user_id, time DESC);

-- Tiger Data (Timescale) only. OMIT on the Supabase / plain Postgres pivot:
-- the extension is not available there and the statement will fail.
-- SELECT create_hypertable('tab_events', 'time', if_not_exists => TRUE);

CREATE TABLE plan_items (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspaces (id, user_id) ON DELETE CASCADE
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspaces (id, user_id) ON DELETE CASCADE
);

CREATE TABLE action_runs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  action_id TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES workspaces (id, user_id) ON DELETE CASCADE
);

-- from/to workspace ids are snapshots (NULL = Other), like tab_events.
CREATE TABLE corrections (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  from_workspace_id UUID,
  to_workspace_id UUID,
  tab_ref_id UUID,
  url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tab_ref_id, user_id)
    REFERENCES tab_refs (id, user_id) ON DELETE SET NULL (tab_ref_id)
);
