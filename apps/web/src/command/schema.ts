// The strict answer shape of the interpreter call (specs/011-global-command-bar/contracts/model.md).
// Standard JSON Schema: each provider translates it to what its API accepts. The intent list is a
// literal copy of COMMAND_INTENTS from @ai-browser/shared (server code imports only types from the
// shared package); tests/command-validate.test.ts asserts the two agree.

export const COMMAND_INTENT_LIST = [
  "organize",
  "cleanup",
  "group",
  "move",
  "rename",
  "merge",
  "create",
  "show",
  "open_workspace",
  "find",
  "recall",
  "undo",
  "agent",
] as const;

/** The 13 real intents plus the three answers that are not actions. */
export const INTENT_ENUM = [...COMMAND_INTENT_LIST, "clarify", "multiple", "unsupported"] as const;
export type InterpretedIntent = (typeof INTENT_ENUM)[number];

export const PERIOD_KINDS = ["today", "yesterday", "this_week", "last_week", "last_7_days", "weekday", "date"] as const;
export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export const AGENT_ANSWERS = ["summarize", "compare", "missing", "next-steps", "refs"] as const;
export const ALTERNATIVE_KEYS = ["organize", "cleanup", "create", "show"] as const;

const strings = { type: "array", items: { type: "string" } };

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "intent",
    "confidence",
    "agent",
    "subject",
    "subjectNamed",
    "destination",
    "destinationNamed",
    "toOther",
    "thisWorkspace",
    "scope",
    "tabs",
    "workspaces",
    "name",
    "period",
    "reason",
    "alternatives",
    "parts",
  ],
  properties: {
    intent: { type: "string", enum: [...INTENT_ENUM] },
    confidence: { type: "number" },
    agent: { type: ["string", "null"], enum: [...AGENT_ANSWERS, null] },
    subject: strings,
    subjectNamed: { type: "boolean" },
    destination: strings,
    destinationNamed: { type: "boolean" },
    toOther: { type: "boolean" },
    thisWorkspace: { type: "boolean" },
    scope: { type: "string", enum: ["none", "these_tabs", "this_tab"] },
    tabs: strings,
    workspaces: strings,
    name: { type: ["string", "null"] },
    period: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["kind", "date", "weekday"],
      properties: {
        kind: { type: "string", enum: [...PERIOD_KINDS] },
        date: { type: ["string", "null"] },
        weekday: { type: ["string", "null"], enum: [...WEEKDAYS, null] },
      },
    },
    reason: { type: ["string", "null"], enum: ["not_supported", "page_content", null] },
    alternatives: { type: "array", items: { type: "string", enum: [...ALTERNATIVE_KEYS] } },
    parts: strings,
  },
} as const;
