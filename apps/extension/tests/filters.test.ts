import { describe, expect, it } from "vitest";
import { clampUrl, isEligibleTab, isEligibleUrl, MAX_URL_LENGTH } from "../src/filters";

describe("isEligibleUrl", () => {
  it("accepts http and https pages", () => {
    expect(isEligibleUrl("http://example.com/a")).toBe(true);
    expect(isEligibleUrl("https://example.com/a?b=1#c")).toBe(true);
    expect(isEligibleUrl("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it.each([
    "chrome://settings",
    "chrome-extension://abcdef/popup.html",
    "about:blank",
    "file:///Users/me/notes.txt",
    "view-source:https://example.com",
    "ftp://example.com/file",
    "data:text/html,hello",
    "javascript:alert(1)",
  ])("rejects %s", (url) => {
    expect(isEligibleUrl(url)).toBe(false);
  });

  it("rejects empty, missing, and malformed URLs", () => {
    expect(isEligibleUrl("")).toBe(false);
    expect(isEligibleUrl(undefined)).toBe(false);
    expect(isEligibleUrl("not a url")).toBe(false);
    expect(isEligibleUrl("https:")).toBe(false);
  });
});

describe("isEligibleTab", () => {
  it("accepts a normal-window https tab", () => {
    expect(isEligibleTab({ url: "https://example.com", incognito: false })).toBe(true);
  });

  it("treats a missing incognito flag as not incognito", () => {
    expect(isEligibleTab({ url: "https://example.com" })).toBe(true);
  });

  it("rejects an incognito tab even with an https URL", () => {
    expect(isEligibleTab({ url: "https://example.com", incognito: true })).toBe(false);
  });

  it("rejects a normal-window tab on an internal page", () => {
    expect(isEligibleTab({ url: "chrome://newtab", incognito: false })).toBe(false);
  });

  it("rejects a tab with no readable URL", () => {
    expect(isEligibleTab({ incognito: false })).toBe(false);
  });
});

describe("clampUrl", () => {
  it("leaves short URLs alone", () => {
    expect(clampUrl("https://example.com/a")).toBe("https://example.com/a");
  });

  it("truncates URLs longer than the limit instead of rejecting them", () => {
    const long = "https://example.com/" + "a".repeat(MAX_URL_LENGTH * 2);
    const clamped = clampUrl(long);
    expect(clamped).toHaveLength(MAX_URL_LENGTH);
    expect(long.startsWith(clamped)).toBe(true);
  });
});
