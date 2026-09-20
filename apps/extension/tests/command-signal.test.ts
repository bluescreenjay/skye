import { beforeEach, describe, expect, it, vi } from "vitest";
import { onSignal, sendSignal, SIGNAL_FRESH_MS, SIGNAL_KEY, takeFreshSignal, type CommandSignal } from "../src/ui/command-signal";
import { installChromeMock, type ChromeMock } from "./helpers/chrome-mock";

let mock: ChromeMock;
beforeEach(() => {
  mock = installChromeMock();
});

describe("command signals", () => {
  it("delivers a signal to a listener, with a time stamp", async () => {
    const seen: CommandSignal[] = [];
    onSignal((s) => seen.push(s));
    await sendSignal({ kind: "open", tabId: 7 }, 1_000);
    expect(seen).toEqual([{ kind: "open", tabId: 7, at: 1_000 }]);
  });

  it("delivers two identical signals as two events (the time stamp always goes up)", async () => {
    const seen: CommandSignal[] = [];
    onSignal((s) => seen.push(s));
    await sendSignal({ kind: "changed" }, 5_000);
    await sendSignal({ kind: "changed" }, 5_000);
    await sendSignal({ kind: "changed" }, 1); // even a clock that went backwards
    expect(seen).toHaveLength(3);
    expect(new Set(seen.map((s) => s.at)).size).toBe(3);
    expect(seen[2].at).toBeGreaterThan(seen[1].at);
  });

  it("carries a navigate target", async () => {
    const seen: CommandSignal[] = [];
    onSignal((s) => seen.push(s));
    await sendSignal({ kind: "navigate", target: { kind: "workspace", workspaceId: "w-1" } }, 2_000);
    expect(seen[0]).toMatchObject({ kind: "navigate", target: { kind: "workspace", workspaceId: "w-1" } });
  });

  it("ignores changes to other keys and to the local area", async () => {
    const handler = vi.fn();
    onSignal(handler);
    await chrome.storage.session.set({ somethingElse: { kind: "open", at: 1 } });
    await chrome.storage.local.set({ [SIGNAL_KEY]: { kind: "open", tabId: 1, at: 1 } });
    await chrome.storage.session.set({ [SIGNAL_KEY]: { kind: "explode", at: 2 } }); // not a signal
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops delivering after unsubscribe", async () => {
    const handler = vi.fn();
    const stop = onSignal(handler);
    stop();
    await sendSignal({ kind: "changed" }, 3_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("takes a fresh signal on mount, once", async () => {
    await sendSignal({ kind: "open", tabId: "new" }, 10_000);
    const first = await takeFreshSignal(0, 10_000 + 500);
    expect(first).toMatchObject({ kind: "open", tabId: "new" });
    // Already handled: not taken twice.
    expect(await takeFreshSignal(first!.at, 10_000 + 600)).toBeNull();
  });

  it("does not take a stale signal", async () => {
    await sendSignal({ kind: "open", tabId: 1 }, 10_000);
    // The stamp only ever goes up (module state), so read back what was actually stored.
    const at = (mock.session.get(SIGNAL_KEY) as CommandSignal).at;
    expect(await takeFreshSignal(0, at + SIGNAL_FRESH_MS + 1)).toBeNull();
    expect(await takeFreshSignal(0, at + SIGNAL_FRESH_MS)).not.toBeNull();
  });

  it("returns null when nothing was ever sent", async () => {
    expect(await takeFreshSignal(0)).toBeNull();
  });

  it("swallows a storage error on send, on take, and on subscribe", async () => {
    (chrome.storage.session as unknown as { set: () => Promise<void> }).set = () => Promise.reject(new Error("quota"));
    (chrome.storage.session as unknown as { get: () => Promise<never> }).get = () => Promise.reject(new Error("gone"));
    await expect(sendSignal({ kind: "changed" })).resolves.toBeUndefined();
    await expect(takeFreshSignal(0)).resolves.toBeNull();
    (chrome.storage as unknown as { onChanged: unknown }).onChanged = undefined;
    expect(() => onSignal(() => undefined)()).not.toThrow();
    expect(mock.session.size).toBe(0);
  });
});
