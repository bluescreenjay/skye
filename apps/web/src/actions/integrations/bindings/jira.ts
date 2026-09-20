import type { Binding } from "./github";

function escapeJql(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export const JIRA_BINDINGS: Binding[] = [
  {
    toolId: "jira_create_issue",
    integration: "jira",
    candidates: ["createJiraIssue", "jira_create_issue"],
    what: "issue",
    toArguments: (args, dest) => ({
      projectKey: dest,
      summary: args.summary,
      description: args.description ?? "",
      issueTypeName: args.type ?? "Task",
    }),
  },
  {
    toolId: "jira_search",
    integration: "jira",
    candidates: ["searchJiraIssuesUsingJql", "jira_search"],
    what: "search",
    search: true,
    toArguments: (args, dest) => ({ jql: `project = ${dest} AND text ~ "${escapeJql(String(args.text ?? ""))}"` }),
  },
  {
    toolId: "jira_add_comment",
    integration: "jira",
    candidates: ["addCommentToJiraIssue", "jira_add_comment"],
    what: "comment",
    toArguments: (args) => ({ issueIdOrKey: args.key, commentBody: args.body }),
  },
];
