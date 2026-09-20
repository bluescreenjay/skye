import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";
import { ProposalError, refreshProposal } from "@/src/project-assistant/proposals";

export const runtime = "nodejs";
export const OPTIONS = optionsResponse;
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try { return json({ proposal: await refreshProposal(auth.user!.id, (await params).id) }); }
  catch (error) { return error instanceof ProposalError ? errorJson(error.message, error.status) : errorJson("Could not load action", 500); }
}
