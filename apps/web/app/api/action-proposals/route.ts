import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";
import { createProposal, listProposals, ProposalError } from "@/src/project-assistant/proposals";

export const runtime = "nodejs";
export const OPTIONS = optionsResponse;
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try { return json({ proposals: await listProposals(auth.user!.id) }); }
  catch { return errorJson("Could not load actions", 500); }
}
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try { return json({ proposal: await createProposal(auth.user!.id, await request.json()) }, 201); }
  catch (error) { return error instanceof ProposalError ? errorJson(error.message, error.status) : errorJson("Could not prepare that action", 500); }
}
