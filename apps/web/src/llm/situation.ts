// What kind of failure an AI call ended in, so chat and agents (which each write their own
// sentences) cannot drift apart on what "busy", "quota", "daily", or "VPN" mean. The error's
// own fixed text is used only to tell situations apart; it is never shown to a person.
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "./errors";

export type FailureSituation = "unconfigured" | "busy" | "quota" | "daily" | "vpn" | "generic";

export function describeFailure(error: unknown): FailureSituation {
  if (error instanceof ModelUnconfiguredError) return "unconfigured";
  if (error instanceof BudgetExceededError) {
    if (/busy/i.test(error.message)) return "busy";
    if (/quota/i.test(error.message)) return "quota";
    return "daily";
  }
  if (error instanceof ModelError && /\bVPN\b/.test(error.message)) return "vpn";
  return "generic";
}
