// The start of every agents route: who is asking, and which workspace is it about. Another
// person's workspace, one that does not exist, and an id that is not a UUID all look the same
// (404), so a route never confirms that someone else's workspace exists. Nothing here logs.
import { requireUser } from "../auth";
import { findWorkspace } from "../chat/messages";
import { errorJson, json } from "../json";
import { notAWorkspace } from "./errors";
import type { DbWorkspace } from "../map";

export type RouteContext = { params: Promise<{ id: string }> };

export type Authorized = { userId: string; workspace: DbWorkspace; response?: undefined } | { response: Response };

/**
 * The signed-in person and the workspace from the path, or the response to send instead: 401 when
 * not signed in, 400 for the reserved id `other` (tabs with no workspace), 404 for anything else that
 * is not this person's workspace. The order matters: the person is checked first, so an unsigned
 * call is 401 whatever the id, and `other` is answered before any lookup.
 */
export async function authorizeWorkspace(request: Request, context: RouteContext): Promise<Authorized> {
  const { user, error } = await requireUser(request);
  if (error) return { response: error };
  const { id } = await context.params;
  if (id === "other") {
    const refused = notAWorkspace();
    return { response: json({ error: refused.message, code: refused.code }, refused.status) };
  }
  const workspace = await findWorkspace(user!.id, id);
  if (!workspace) return { response: errorJson("Workspace not found", 404) };
  return { userId: user!.id, workspace };
}
