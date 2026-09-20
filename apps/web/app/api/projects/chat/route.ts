import { requireUser } from "@/src/auth";
import { getChatModel } from "@/src/chat/model";
import { errorJson, json, optionsResponse } from "@/src/json";
import { askProjects, projectHistory } from "@/src/project-assistant/chat";

export const runtime = "nodejs";
export const maxDuration = 60;
export const OPTIONS = optionsResponse;

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try { return json({ messages: await projectHistory(auth.user!.id) }); }
  catch { return errorJson("Could not load project history", 500); }
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null);
  const message = body && typeof body.message === "string" ? body.message.trim() : "";
  if (!message || message.length > 4_000) return errorJson("Enter a question of at most 4,000 characters", 400);
  try {
    getChatModel();
    return json(await askProjects(auth.user!.id, message));
  } catch (error) {
    if (error instanceof Error && error.name === "ModelUnconfiguredError") return errorJson("The AI assistant isn't configured", 503);
    return errorJson("Could not answer that question", 502);
  }
}
