import { requireUser } from "@/src/auth";
import { corsHeaders, errorJson, optionsResponse } from "@/src/json";

export const runtime = "nodejs";
export const maxDuration = 35;
export const OPTIONS = optionsResponse;

const MAX_TEXT_LENGTH = 8_000;
const LIMIT = 20;
const calls = new Map<string, { count: number; since: number }>();

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key) return errorJson("Voice output is unavailable", 503);
  const body = await request.json().catch(() => null) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, MAX_TEXT_LENGTH) : "";
  if (!text) return errorJson("Provide text to read aloud", 400);
  const userId = auth.user!.id;
  const now = Date.now();
  const prior = calls.get(userId);
  const window = !prior || now - prior.since > 60_000 ? { count: 0, since: now } : prior;
  if (window.count >= LIMIT) return errorJson("Too many voice requests. Try again shortly.", 429);
  window.count += 1;
  calls.set(userId, window);
  const voiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || "21m00Tcm4TlvDq8ikWAM";
  try {
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`, {
      method: "POST", headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }), signal: AbortSignal.timeout(25_000),
    });
    if (!response.ok) return errorJson(`Voice playback failed (${response.status})`, response.status === 402 ? 402 : 502);
    return new Response(response.body, { status: 200, headers: { ...corsHeaders(), "Content-Type": "audio/mpeg", "Cache-Control": "no-store" } });
  } catch { return errorJson("Voice playback failed", 502); }
}
