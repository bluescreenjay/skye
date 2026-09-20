import { GITHUB_BINDINGS, type Binding } from "./github";
import { JIRA_BINDINGS } from "./jira";
import { NOTION_BINDINGS } from "./notion";
import { SLACK_BINDINGS } from "./slack";
import { DRIVE_BINDINGS, GMAIL_BINDINGS } from "./drive";

export type { Binding };

export const ALL_BINDINGS: Binding[] = [
  ...GITHUB_BINDINGS,
  ...JIRA_BINDINGS,
  ...NOTION_BINDINGS,
  ...SLACK_BINDINGS,
  ...DRIVE_BINDINGS,
  ...GMAIL_BINDINGS,
];

export function bindingFor(toolId: string): Binding | undefined {
  return ALL_BINDINGS.find((row) => row.toolId === toolId);
}
