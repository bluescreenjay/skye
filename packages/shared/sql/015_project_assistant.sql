CREATE TABLE IF NOT EXISTS project_messages (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  citations JSONB NOT NULL DEFAULT '[]'::jsonb,
  coverage JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_messages_history_idx ON project_messages(user_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS action_proposals (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_scope TEXT NOT NULL CHECK (source_scope IN ('project', 'workspace')),
  source_id UUID NOT NULL,
  workspace_id UUID,
  tool_id TEXT NOT NULL CHECK (tool_id IN ('notion_create_page', 'gmail_send_message')),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  recipient TEXT,
  state TEXT NOT NULL DEFAULT 'proposed' CHECK (state IN ('proposed', 'running', 'ready_to_send', 'succeeded', 'failed', 'cancelled', 'expired')),
  result JSONB,
  run_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes'),
  FOREIGN KEY (workspace_id, user_id) REFERENCES workspaces(id, user_id) ON DELETE SET NULL (workspace_id)
);
CREATE INDEX IF NOT EXISTS action_proposals_user_idx ON action_proposals(user_id, created_at DESC);
