import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLUSTER_SCHEMA, getModel } from "@/src/cluster/model";
import { resetForTests as resetBudget } from "@/src/llm/budget";
import { ModelUnconfiguredError } from "@/src/llm/errors";
import { toGeminiSchema } from "@/src/llm/gemini";
import { activeProvider, generateJson, modelFor, providerConfigured, unconfiguredMessage } from "@/src/llm";
import { resetLimiterForTests } from "@/src/llm/limiter";

const saved = { ...process.env };
beforeEach(() => {
  resetBudget();
  resetLimiterForTests();
  for (const name of ["LLM_PROVIDER", "LLM_MODEL", "LLM_MODEL_CLUSTER", "GEMINI_MODEL", "GEMINI_MODEL_CLUSTER", "LLM_API_KEY", "LLM_DAILY_CAP"]) delete process.env[name];
  process.env.VT_LLM_API_KEY = "";
  process.env.GEMINI_API_KEY = "";
});
afterEach(() => {
  process.env = { ...saved };
  resetBudget();
  resetLimiterForTests();
});

describe("choosing the provider (LLM_PROVIDER)", () => {
  it("defaults to the VT provider, and switches to Gemini on request (any case, any spacing)", () => {
    expect(activeProvider()).toBe("vt");
    process.env.LLM_PROVIDER = "vt";
    expect(activeProvider()).toBe("vt");
    process.env.LLM_PROVIDER = "  Gemini ";
    expect(activeProvider()).toBe("gemini");
    process.env.LLM_PROVIDER = "";
    expect(activeProvider()).toBe("vt");
  });

  it("rejects an unknown provider instead of silently picking one", () => {
    process.env.LLM_PROVIDER = "openai";
    expect(() => activeProvider()).toThrow(ModelUnconfiguredError);
    expect(() => getModel()).toThrow(ModelUnconfiguredError);
  });

  it("is configured only when the ACTIVE provider has its key", () => {
    expect(providerConfigured()).toBe(false);
    process.env.GEMINI_API_KEY = "g-key";
    expect(providerConfigured()).toBe(false); // vt is active and has no key
    process.env.VT_LLM_API_KEY = "v-key";
    expect(providerConfigured()).toBe(true);
    process.env.LLM_PROVIDER = "gemini";
    expect(providerConfigured()).toBe(true);
    process.env.GEMINI_API_KEY = "";
    expect(providerConfigured()).toBe(false); // gemini is active and has no key
  });

  it("names what to set when there is no key, and never contains a key", () => {
    process.env.VT_LLM_API_KEY = "";
    expect(unconfiguredMessage()).toContain("VT_LLM_API_KEY");
    expect(unconfiguredMessage()).toContain("LLM_PROVIDER=gemini");
    process.env.LLM_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "";
    expect(unconfiguredMessage()).toContain("GEMINI_API_KEY");
    process.env.GEMINI_API_KEY = "super-secret-value";
    expect(unconfiguredMessage()).not.toContain("super-secret-value");
  });

  it("the clustering model refuses to start with the guidance message when the key is missing", () => {
    expect(() => getModel()).toThrow(/VT_LLM_API_KEY/);
  });

  it("picks the model id from the active provider's own settings", () => {
    expect(modelFor("cluster")).toBe("gpt-oss-120b-thinking-low");
    expect(modelFor("chat")).toBe("gpt-oss-120b-thinking-low");
    expect(modelFor("actions")).toBe("gpt-oss-120b");
    process.env.LLM_MODEL_CLUSTER = "custom-vt";
    expect(modelFor("cluster")).toBe("custom-vt");
    process.env.LLM_PROVIDER = "gemini";
    expect(modelFor("cluster")).toBe("gemini-3.5-flash-lite");
    process.env.GEMINI_MODEL_CLUSTER = "gemini-custom";
    expect(modelFor("cluster")).toBe("gemini-custom");
  });
});

describe("generateJson goes to the active provider, with the same call", () => {
  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const opts = (fetchImpl: unknown) => ({ purpose: "cluster" as const, prompt: "p", schema, fetchImpl: fetchImpl as typeof fetch, sleep: async () => undefined });

  it("VT by default: an OpenAI-shaped request to the VT host", async () => {
    process.env.VT_LLM_API_KEY = "v-key";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }), { status: 200 }));
    await expect(generateJson(opts(fetchImpl))).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).host).toBe("llm-api.arc.vt.edu");
    expect(JSON.parse(init.body as string).response_format.type).toBe("json_schema");
  });

  it("Gemini when selected: a Gemini-shaped request with the schema translated to its dialect", async () => {
    process.env.LLM_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "g-key";
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 }));
    await expect(generateJson(opts(fetchImpl))).resolves.toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).host).toBe("generativelanguage.googleapis.com");
    const sent = JSON.parse(init.body as string);
    expect(sent.generationConfig.responseSchema).toEqual({ type: "OBJECT", required: ["ok"], properties: { ok: { type: "BOOLEAN" } } });
  });

  it("never calls a provider that has no key", async () => {
    const fetchImpl = vi.fn();
    await expect(generateJson(opts(fetchImpl))).rejects.toBeInstanceOf(ModelUnconfiguredError);
    process.env.LLM_PROVIDER = "gemini";
    await expect(generateJson(opts(fetchImpl))).rejects.toBeInstanceOf(ModelUnconfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the clustering schema works for both providers", () => {
  it("is standard JSON Schema for VT: strict-friendly and nullable as a type array", () => {
    const item = (CLUSTER_SCHEMA.properties.groups.items as { properties: Record<string, { type: unknown }>; additionalProperties: boolean; required: string[] });
    expect(CLUSTER_SCHEMA.additionalProperties).toBe(false);
    expect(item.additionalProperties).toBe(false);
    expect(item.required).toEqual(["name", "emoji", "confidence", "existingWorkspaceId", "tabIds"]);
    expect(item.properties.emoji.type).toEqual(["string", "null"]);
  });

  it("translates to Gemini's dialect: uppercase types, nullable flags, no additionalProperties", () => {
    const g = toGeminiSchema(CLUSTER_SCHEMA) as {
      type: string;
      required: string[];
      additionalProperties?: unknown;
      properties: { groups: { type: string; items: { type: string; required: string[]; additionalProperties?: unknown; properties: Record<string, { type: string; nullable?: boolean; items?: { type: string } }> } } };
    };
    expect(g.type).toBe("OBJECT");
    expect(g.additionalProperties).toBeUndefined();
    expect(g.properties.groups.type).toBe("ARRAY");
    const item = g.properties.groups.items;
    expect(item.type).toBe("OBJECT");
    expect(item.additionalProperties).toBeUndefined();
    // the two nullable fields are not required for Gemini (see toGeminiSchema)
    expect(item.required).toEqual(["name", "confidence", "tabIds"]);
    expect(item.properties.name).toEqual({ type: "STRING" });
    expect(item.properties.emoji).toEqual({ type: "STRING", nullable: true });
    expect(item.properties.existingWorkspaceId).toEqual({ type: "STRING", nullable: true });
    expect(item.properties.confidence).toEqual({ type: "NUMBER" });
    expect(item.properties.tabIds).toEqual({ type: "ARRAY", items: { type: "STRING" } });
  });

  it("keeps a required property required unless it can be null", () => {
    const g = toGeminiSchema({ type: "object", required: ["a", "b"], properties: { a: { type: "string" }, b: { type: ["string", "null"] } } }) as { required: string[] };
    expect(g.required).toEqual(["a"]);
  });

  it("does not mutate the original schema", () => {
    const before = JSON.stringify(CLUSTER_SCHEMA);
    toGeminiSchema(CLUSTER_SCHEMA);
    expect(JSON.stringify(CLUSTER_SCHEMA)).toBe(before);
  });
});
