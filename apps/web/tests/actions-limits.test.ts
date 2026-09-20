import { afterEach, describe, expect, it } from "vitest";
import { suggestReuseS, TITLE_CHARS, MAX_TURNS, SAVED_QUERIES_MAX } from "@/src/actions/limits";

afterEach(() => {
  delete process.env.ACTIONS_SUGGEST_REUSE_S;
});

describe("action-tool limits", () => {
  it("default to the values in the plan", () => {
    expect(suggestReuseS()).toBe(300);
    expect(TITLE_CHARS).toBe(200);
    expect(MAX_TURNS).toBe(4);
    expect(SAVED_QUERIES_MAX).toBe(10);
  });

  it("can be overridden by environment variables, read at call time", () => {
    process.env.ACTIONS_SUGGEST_REUSE_S = "0";
    expect(suggestReuseS()).toBe(0);
    process.env.ACTIONS_SUGGEST_REUSE_S = "60";
    expect(suggestReuseS()).toBe(60);
  });

  it("falls back to the default for anything invalid or out of range", () => {
    for (const bad of ["", "abc", "1.5", "-2", "99999999"]) {
      process.env.ACTIONS_SUGGEST_REUSE_S = bad;
      expect(suggestReuseS()).toBe(300);
    }
  });
});
