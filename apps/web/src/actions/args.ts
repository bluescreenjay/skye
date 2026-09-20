// Validate, lock, and expand tool arguments (specs/010b-mcp-action-tools/research.md section 6).
// Prefill wins. Over-limit text is refused, never silently cut. Nothing here logs argument values.
import { badInput } from "./errors";
import type { ArgFlags, JsonSchema, ToolDef } from "./registry";
import { BODY_CHARS } from "./limits";

export class ArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArgsError";
  }
}

function throwBad(sentence: string): never {
  throw badInput(sentence);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function lengthOf(schema: JsonSchema): { min?: number; max?: number } {
  return { min: schema.minLength, max: schema.maxLength };
}

function checkString(name: string, value: unknown, schema: JsonSchema): string {
  const text = asString(value);
  if (text === null) throwBad(`"${name}" has to be text.`);
  const { min, max } = lengthOf(schema);
  if (min !== undefined && text.trim().length < min) throwBad(`"${name}" is too short.`);
  if (max !== undefined && text.length > max) throwBad(`"${name}" is too long (at most ${max} characters).`);
  if (schema.enum && !schema.enum.includes(text)) throwBad(`"${name}" isn't a valid choice.`);
  return text;
}

function checkNumber(name: string, value: unknown, schema: JsonSchema): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throwBad(`"${name}" has to be a whole number.`);
  if (schema.minimum !== undefined && value < schema.minimum) throwBad(`"${name}" is too small.`);
  if (schema.maximum !== undefined && value > schema.maximum) throwBad(`"${name}" is too large.`);
  return value;
}

function checkBoolean(name: string, value: unknown): boolean {
  if (typeof value !== "boolean") throwBad(`"${name}" has to be yes or no.`);
  return value;
}

function checkArray(name: string, value: unknown, schema: JsonSchema): unknown[] {
  if (!Array.isArray(value)) throwBad(`"${name}" has to be a list.`);
  const min = schema.minItems ?? 0;
  const max = schema.maxItems ?? 50;
  if (value.length < min) throwBad(`"${name}" needs at least ${min}.`);
  if (value.length > max) throwBad(`"${name}" has too many items (at most ${max}).`);
  const item = schema.items;
  if (!item) return value;
  return value.map((entry, i) => checkValue(`${name}[${i}]`, entry, item));
}

function checkObject(name: string, value: unknown, schema: JsonSchema): Record<string, unknown> {
  if (!isPlainObject(value)) throwBad(`"${name}" has to be a set of fields.`);
  const out: Record<string, unknown> = {};
  const props = schema.properties ?? {};
  for (const key of Object.keys(value)) {
    if (!(key in props)) continue;
    out[key] = checkValue(`${name}.${key}`, value[key], props[key]);
  }
  for (const req of schema.required ?? []) {
    if (out[req] === undefined) throwBad(`"${req}" is required.`);
  }
  return out;
}

function checkValue(name: string, value: unknown, schema: JsonSchema): unknown {
  switch (schema.type) {
    case "string":
      return checkString(name, value, schema);
    case "integer":
    case "number":
      return checkNumber(name, value, schema);
    case "boolean":
      return checkBoolean(name, value);
    case "array":
      return checkArray(name, value, schema);
    case "object":
      return checkObject(name, value, schema);
    default:
      return value;
  }
}

/** Drop unknown names, enforce schema and limits. Does not require missing fields (composed runs fill those). */
export function validateArgs(
  tool: ToolDef,
  args: Record<string, unknown>,
  options: { requireVisible?: boolean } = {},
): Record<string, unknown> {
  if (!isPlainObject(args)) throwBad("That request wasn't in the expected form.");
  const schema = tool.inputSchema;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    const prop = schema.properties[name];
    if (!prop) continue;
    out[name] = checkValue(name, value, prop);
  }
  if (options.requireVisible) {
    for (const [name, flags] of Object.entries(tool.argFlags)) {
      if ((flags.visible || flags.prefillOnly) && out[name] === undefined) {
        throwBad(`"${name}" has to be filled in before this action can run.`);
      }
    }
  }
  return out;
}

/** Locked prefill wins. The model may fill only names that are still missing. Extra names ignored. */
export function lockedMerge(locked: Record<string, unknown>, modelArgs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...locked };
  for (const [name, value] of Object.entries(modelArgs)) {
    if (out[name] !== undefined) continue;
    out[name] = value;
  }
  return out;
}

function expandOne(value: unknown, vars: { summary: string; workspace: string }): unknown {
  if (typeof value === "string") {
    return value.replaceAll("{{summary}}", vars.summary.slice(0, BODY_CHARS)).replaceAll("{{workspace}}", vars.workspace);
  }
  if (Array.isArray(value)) return value.map((item) => expandOne(item, vars));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandOne(v, vars);
    return out;
  }
  return value;
}

export function expandPlaceholders(
  args: Record<string, unknown>,
  vars: { summary: string; workspace: string },
): Record<string, unknown> {
  return expandOne(args, vars) as Record<string, unknown>;
}

/** One syntactically valid address: no commas, no CR/LF, no display name. */
export function isValidRecipient(to: string): boolean {
  const trimmed = to.trim();
  if (trimmed !== to.replace(/\s+/g, "")) return false;
  if (/[,\r\n<>()]/.test(trimmed)) return false;
  if (/\s/.test(trimmed)) return false;
  return /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(
    trimmed,
  );
}

export function flagsOf(tool: ToolDef, name: string): ArgFlags {
  return tool.argFlags[name] ?? {};
}

export { throwBad };
