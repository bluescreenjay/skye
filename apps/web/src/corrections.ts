// A correction is the user overriding where the AI put a tab (constitution principle III:
// corrections are kept as signals for later organization). Recorded, never acted on here.
import { randomUUID } from "crypto";
import { query } from "./db";

/** Record that the user moved an AI-placed tab. `null` means Other. */
export async function recordCorrection(
  userId: string,
  tabRefId: string,
  fromWorkspaceId: string | null,
  toWorkspaceId: string | null,
  url: string,
): Promise<void> {
  await query(
    `INSERT INTO corrections (id, user_id, from_workspace_id, to_workspace_id, tab_ref_id, url)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [randomUUID(), userId, fromWorkspaceId, toWorkspaceId, tabRefId, url],
  );
}
