import { describe, expect, it, vi } from "vitest";
import type { ActionSuggestion, ToolRunView } from "@ai-browser/shared";
import {
  intentsToExecute,
  isHttpsUrl,
  isValidRecipient,
  resultLines,
  shouldPoll,
  stableSwap,
} from "../src/ui/actions";

const suggestion = (id: string, toolId = "list_workspace_tabs"): ActionSuggestion => ({
  id,
  toolId,
  label: `Do ${id}`,
  reason: "Fits this workspace.",
  args: {},
  preview: [],
  effect: "local",
  service: null,
});

const run = (over: Partial<ToolRunView> = {}): ToolRunView => ({
  id: "r1",
  toolId: "list_workspace_tabs",
  state: "running",
  createdAt: "2026-09-19T12:00:00.000Z",
  label: "List",
  output: null,
  error: null,
  awaitingIntents: null,
  ...over,
});

describe("ui action helpers", () => {
  it("polls only while a run is going", () => {
    expect(shouldPoll([])).toBe(false);
    expect(shouldPoll([run({ state: "succeeded" })])).toBe(false);
    expect(shouldPoll([run({ state: "running" })])).toBe(true);
  });

  it("keeps buttons under the cursor", () => {
    const current = [suggestion("s1"), suggestion("s2")];
    const next = [suggestion("s3"), suggestion("s4")];
    expect(stableSwap(current, next, false).suggestions).toEqual(next);
    expect(stableSwap(current, next, true)).toEqual({ suggestions: current, offerNew: true });
  });

  it("executes intents only for session-owned runs", () => {
    const started = new Set(["r1"]);
    const withIntent = run({
      awaitingIntents: [{ id: "i1", kind: "open_tabs", urls: ["https://example.com"], placeInWorkspace: false, workspaceId: "w" }],
    });
    expect(intentsToExecute(withIntent, started)).toHaveLength(1);
    expect(intentsToExecute(withIntent, new Set())).toHaveLength(0);
  });

  it("filters addresses and describes mail results", () => {
    expect(isHttpsUrl("https://a.example/x")).toBe(true);
    expect(isHttpsUrl("http://a.example/x")).toBe(false);
    expect(isValidRecipient("a@b.com")).toBe(true);
    expect(isValidRecipient("Name <a@b.com>")).toBe(false);
    expect(resultLines(run({ state: "succeeded", output: { result: { kind: "mail_search", shown: 3 }, links: [], steps: [], refused: [], stoppedAtLimit: false } }))).toEqual([
      "3 messages were shown; they are not kept",
    ]);
  });
});

void vi;
