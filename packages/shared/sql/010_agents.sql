-- AI Browser 010 schema: workspace agents
-- Source: specs/010-workspace-agents/data-model.md
--
-- Requires 001_init.sql first. Safe to run more than once.
--
-- This feature adds NO table and NO column: an agent run is a row of the existing
-- `action_runs` table (feature 001) and the "next steps" checklist is the existing
-- `plan_items` table. It adds three indexes only.

-- One run at a time per person, workspace, and agent. A second press of the same agent
-- while one is `pending` fails with a unique violation and becomes 409 run_in_progress.
CREATE UNIQUE INDEX IF NOT EXISTS action_runs_one_running_idx
  ON action_runs (user_id, workspace_id, action_id) WHERE status = 'pending';

-- Latest runs and history of one agent in one workspace (newest first).
CREATE INDEX IF NOT EXISTS action_runs_workspace_agent_created_idx
  ON action_runs (user_id, workspace_id, action_id, created_at DESC, id DESC);

-- The checklist read, used by the agents card and by chat.
CREATE INDEX IF NOT EXISTS plan_items_workspace_order_idx
  ON plan_items (user_id, workspace_id, sort_order, id);
