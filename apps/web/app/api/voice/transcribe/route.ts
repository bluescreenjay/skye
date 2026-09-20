import { requireUser } from "@/src/auth";
import { errorJson, json, optionsResponse } from "@/src/json";

export const runtime = "nodejs";
export const maxDuration = 35;
export const OPTIONS = optionsResponse;

const MAX_AUDIO_BYTES = 2_500_000;
const LIMIT = 12;
const calls = new Map<string, { count: number; since: number }>();

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) return errorJson("Voice input is unavailable", 503);
  const userId = auth.user!.id;
  const now = Date.now();
  const prior = calls.get(userId);
  const window = !prior || now - prior.since > 60_000 ? { count: 0, since: now } : prior;
  if (window.count >= LIMIT) return errorJson("Too many voice requests. Try again shortly.", 429);
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_AUDIO_BYTES + 10_000) return errorJson("Recording is too large", 413);
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File) || audio.size < 100 || audio.size > MAX_AUDIO_BYTES || !audio.type.startsWith("audio/")) return errorJson("Record a short audio question", 400);
  window.count += 1;
  calls.set(userId, window);
  const payload = new FormData();
  payload.set("model_id", "scribe_v2");
  payload.set("file", audio);
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST", headers: { "xi-api-key": key }, body: payload, signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) return errorJson("Voice transcription failed", 502);
    const result = await response.json() as { text?: unknown };
    const text = typeof result.text === "string" ? result.text.trim().slice(0, 4_000) : "";
    if (!text) return errorJson("No speech was detected", 422);
    return json({ text });
  } catch { return errorJson("Voice transcription failed", 502); }
}
