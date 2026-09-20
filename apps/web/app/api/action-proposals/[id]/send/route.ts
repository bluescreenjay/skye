import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";
import { ProposalError, sendProposal } from "@/src/project-assistant/proposals";

export const runtime = "nodejs";
export const OPTIONS = optionsResponse;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try { return json({ proposal: await sendProposal(auth.user!.id, (await params).id) }); }
  catch (error) { return error instanceof ProposalError ? errorJson(error.message, error.status) : errorJson("Could not send email", 500); }
}
