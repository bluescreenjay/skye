import { describe, expect, it } from "vitest";
import { GITHUB_BINDINGS } from "@/src/actions/integrations/bindings/github";

describe("mcp bindings", () => {
  it("always adds dest and never lets args override it", () => {
    const row = GITHUB_BINDINGS.find((item) => item.toolId === "github_create_issue")!;
    const mapped = row.toArguments({ title: "t", body: "b", owner: "evil", repo: "other" }, "ours/repo");
    expect(mapped.owner).toBe("ours");
    expect(mapped.repo).toBe("repo");
  });
});
