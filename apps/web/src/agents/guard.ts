// The start of every agents route: who is asking, and which workspace is it about. Another
// person's workspace, one that does not exist, and an id that is not a UUID all look the same
// (404), so a route never confirms that someone else's workspace exists. Nothing here logs.
import { requireUser } from "../auth";
import { findWorkspace } from "../chat/messages";
import { errorJson } from "../json";
import type { DbWorkspace } from "../map";

export type RouteContext = { params: Promise<{ id: string }> };

export type Authorized = { userId: string; workspace: DbWorkspace; response?: undefined } | { response: Response };

/** The signed-in person and the workspace from the path, or the response to send instead (401 or 404). */
export async function authorizeWorkspace(request: Request, context: RouteContext): Promise<Authorized> {
  const { user, error } = await requireUser(request);
  if (error) return { response: error };
  const { id } = await context.params;
  const workspace = await findWorkspace(user!.id, id);
  if (!workspace) return { response: errorJson("Workspace not found", 404) };
  return { userId: user!.id, workspace };
}
