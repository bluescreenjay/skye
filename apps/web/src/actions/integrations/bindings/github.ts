import type { IntegrationId } from "@ai-browser/shared";

export interface Binding {
  toolId: string;
  integration: IntegrationId;
  candidates: string[];
  toArguments: (args: Record<string, unknown>, dest: string) => Record<string, unknown>;
  what: string;
  search?: boolean;
}

function githubOwnerRepo(dest: string): { owner: string; repo: string } {
  const [owner, repo] = dest.split("/");
  return { owner: owner ?? "", repo: repo ?? dest };
}

export const GITHUB_BINDINGS: Binding[] = [
  {
    toolId: "github_create_issue",
    integration: "github",
    candidates: ["create_issue", "issue_write"],
    what: "issue",
    toArguments: (args, dest) => ({ ...githubOwnerRepo(dest), title: args.title, body: args.body, method: "create" }),
  },
  {
    toolId: "github_create_gist",
    integration: "github",
    candidates: ["create_gist"],
    what: "gist",
    toArguments: (args) => ({ filename: args.filename, content: args.content, description: args.description ?? "", public: false }),
  },
  {
    toolId: "github_search",
    integration: "github",
    candidates: ["search_issues", "search_code"],
    what: "search",
    search: true,
    toArguments: (args, dest) => ({ query: `repo:${dest} ${String(args.query ?? "")}` }),
  },
  {
    toolId: "github_comment_on_issue",
    integration: "github",
    candidates: ["add_issue_comment"],
    what: "comment",
    toArguments: (args, dest) => ({ ...githubOwnerRepo(dest), issue_number: args.issue, body: args.body }),
  },
];
