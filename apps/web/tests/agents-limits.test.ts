import { afterEach, describe, expect, it } from "vitest";
import { MAX_RUNNING_PER_USER, maxPages, pageBytes, pageChars, pageTimeoutMs, readBudgetMs } from "@/src/agents/limits";

const NAMES = ["AGENT_MAX_PAGES", "AGENT_PAGE_TIMEOUT_MS", "AGENT_READ_BUDGET_MS", "AGENT_PAGE_BYTES", "AGENT_PAGE_CHARS"];
afterEach(() => NAMES.forEach((n) => delete process.env[n]));

describe("reading limits", () => {
  it("default to the values in the plan", () => {
    expect([maxPages(), pageTimeoutMs(), readBudgetMs(), pageBytes(), pageChars()]).toEqual([8, 8_000, 12_000, 500_000, 4_000]);
    expect(MAX_RUNNING_PER_USER).toBe(5);
  });

  it("can be overridden by environment variables, read at call time", () => {
    process.env.AGENT_MAX_PAGES = "3";
    process.env.AGENT_PAGE_TIMEOUT_MS = "500";
    expect(maxPages()).toBe(3);
    expect(pageTimeoutMs()).toBe(500);
    process.env.AGENT_MAX_PAGES = "5";
    expect(maxPages()).toBe(5);
  });

  it("fall back to the default for anything invalid or out of range", () => {
    for (const bad of ["", "abc", "1.5", "-2", "99999999"]) {
      process.env.AGENT_MAX_PAGES = bad;
      expect(maxPages()).toBe(8);
    }
  });
});
