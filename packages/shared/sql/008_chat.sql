-- AI Browser 008 schema: workspace chat
-- Source: specs/008-workspace-ai-chat/data-model.md
--
-- Requires 001_init.sql first. Safe to run more than once.
--
-- This feature adds NO table and NO column: chat saves its messages in the existing
-- `messages` table from 001. A user message is inserted before the model is asked and the
-- assistant message only after the reply finished, so nothing in the table can be an
-- unfinished reply and no marker is needed.
--
-- The one addition is an index that serves the two reads chat makes on every request:
-- a page of a workspace's conversation (newest first, then reversed) and "what is the
-- newest message here".

CREATE INDEX IF NOT EXISTS messages_user_workspace_created_idx
  ON messages (user_id, workspace_id, created_at DESC, id DESC);
