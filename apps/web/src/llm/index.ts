// The one entry point every AI feature uses. It picks the provider from LLM_PROVIDER:
//   vt      (default) the Virginia Tech ARC LLM API, OpenAI-compatible, on the VT VPN
//   gemini  (backup)  Google Gemini
// One provider is active per deployment. Switching is a config change, never a code change
// (constitution: Pivot rule; specs/004-ai-clustering/research.md section 1).
import type { Purpose } from "./budget";
import { ModelUnconfiguredError } from "./errors";
import { geminiApiKey, geminiGenerateJson, geminiModelFor } from "./gemini";
import { vtApiKey, vtGenerateJson, vtModelFor } from "./openai-compat";
import type { GenerateJsonOptions, Provider } from "./types";

export type { GenerateJsonOptions, Provider } from "./types";

/** LLM_PROVIDER: `vt` when unset. Anything other than `vt` or `gemini` is a configuration error. */
export function activeProvider(): Provider {
  const value = process.env.LLM_PROVIDER?.trim().toLowerCase();
  if (!value || value === "vt") return "vt";
  if (value === "gemini") return "gemini";
  throw new ModelUnconfiguredError('LLM_PROVIDER must be "vt" or "gemini".');
}

/** Whether the active provider has the credentials it needs. */
export function providerConfigured(): boolean {
  return activeProvider() === "gemini" ? geminiApiKey() !== undefined : vtApiKey() !== undefined;
}

/** A fixed, operator-facing message for "no key", naming what to set. Never contains a secret. */
export function unconfiguredMessage(): string {
  return activeProvider() === "gemini"
    ? "No AI model key is configured: set GEMINI_API_KEY."
    : "No AI model key is configured: set VT_LLM_API_KEY, or set LLM_PROVIDER=gemini and GEMINI_API_KEY.";
}

/** The model id the active provider will use for this purpose. */
export function modelFor(purpose: Purpose): string {
  return activeProvider() === "gemini" ? geminiModelFor(purpose) : vtModelFor(purpose);
}

/** One prompt in, one parsed JSON answer out, through the active provider. */
export function generateJson(options: GenerateJsonOptions): Promise<unknown> {
  return activeProvider() === "gemini" ? geminiGenerateJson(options) : vtGenerateJson(options);
}
