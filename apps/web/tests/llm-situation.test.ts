import { describe, expect, it } from "vitest";
import { BudgetExceededError, ModelError, ModelUnconfiguredError } from "@/src/llm/errors";
import { describeFailure } from "@/src/llm/situation";

describe("describeFailure: one classification for chat and agents", () => {
  it("tells the situations apart from the errors' own fixed text", () => {
    expect(describeFailure(new ModelUnconfiguredError())).toBe("unconfigured");
    expect(describeFailure(new BudgetExceededError("The AI service is busy right now. Try again in a moment."))).toBe("busy");
    expect(describeFailure(new BudgetExceededError("The AI service's quota has been reached. Try again later."))).toBe("quota");
    expect(describeFailure(new BudgetExceededError())).toBe("daily");
    expect(describeFailure(new ModelError("The AI service is only reachable on the VT VPN. Connect to it, or set LLM_PROVIDER=gemini."))).toBe("vpn");
    expect(describeFailure(new ModelError())).toBe("generic");
  });

  it("anything else is generic, including things that are not errors at all", () => {
    expect(describeFailure(new TypeError("boom"))).toBe("generic");
    expect(describeFailure("a string")).toBe("generic");
    expect(describeFailure(undefined)).toBe("generic");
  });
});
