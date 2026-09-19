-- AI Browser 001 schema skeleton
-- Preferred: Tiger Data / Timescale Postgres
-- Pivot: skip the create_hypertable call; tab_events remains a regular table

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX workspaces_user_id_idx ON workspaces (user_id);

CREATE TABLE tab_refs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES workspaces (id) ON DELETE SET NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  chrome_tab_id INTEGER,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tab_refs_user_workspace_chk CHECK (
    workspace_id IS NULL OR user_id IS NOT NULL
  )
);

CREATE INDEX tab_refs_user_workspace_idx ON tab_refs (user_id, workspace_id);

CREATE TABLE tab_events (
  time TIMESTAMPTZ NOT NULL,
  id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tab_ref_id UUID REFERENCES tab_refs (id) ON DELETE SET NULL,
  chrome_tab_id INTEGER,
  url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  workspace_id UUID,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('opened', 'updated', 'activated', 'closed', 'reassigned')),
  PRIMARY KEY (time, id)
);

CREATE INDEX tab_events_user_time_idx ON tab_events (user_id, time DESC);

-- Tiger Data only (omit on Supabase/plain Postgres pivot):
-- SELECT create_hypertable('tab_events', 'time', if_not_exists => TRUE);

CREATE TABLE plan_items (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE messages (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE action_runs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  action_id TEXT NOT NULL,
  input JSONB NOT NULL DEFAULT '{}'::jsonb,
  output JSONB,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'succeeded', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE corrections (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  from_workspace_id UUID,
  to_workspace_id UUID,
  tab_ref_id UUID REFERENCES tab_refs (id) ON DELETE SET NULL,
  url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
