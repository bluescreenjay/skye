# Contract: Integrations, connections, and bindings

How the 18 service tools reach GitHub, Jira, Notion, Slack, Google Drive, and Gmail (research 2, 3, 4). Nothing here is shown to a person; there is no screen for it (spec Assumptions).

**Status of the facts**: the environment variable names and the `ToolConnector` shape below are this feature's own design and are fixed. The **server-side tool names and argument names in the binding column are best-effort from public documentation as of 2026-09-19 and were not run against live servers at planning time.** Each is checked by the read-only probe (`ACTIONS_LIVE_<NAME>=1`, below); a binding that does not resolve makes that tool *unavailable* (not suggested), never a crash. Adjusting a binding is a one-file change in `src/actions/integrations/bindings/`.

## The connector seam

```ts
// src/actions/integrations/connector.ts
type ConnectionStatus = "connected" | "missing" | "rejected";
interface ConnectorResult { text: string; links: { label: string; url: string | null; id: string | null }[]; items?: SearchItem[] }
interface ToolConnector {
  status(integration: IntegrationId): ConnectionStatus;
  available(toolId: string): boolean;                       // status connected AND a server tool is bound for it
  call(toolId: string, args: ValidatedArgs, signal: AbortSignal): Promise<ConnectorResult>;   // throws ConnectorError with a fixed code
}
type ConnectorErrorCode = "not_connected" | "rejected_credentials" | "service_error" | "timed_out";
```

- `getConnector()` returns the MCP-backed one; `setConnectorForTests(fake)` swaps it. **Availability is computed from status only for suggestions and the click checks; no network call is made while a card opens** (the first `tools/list` happens on first use or first suggestion pass that needs it, at most one per integration per 5 minutes, and never blocks the card: an integration whose check is not finished counts as not yet available).
- `ConnectorError` messages are fixed; a service's own words are never copied into an error, a step, or a run (FR-041).

## Environment variables

All optional. Nothing here is committed; `.env.example` lists them commented out. **An integration is `connected` only when its transport, its credential, and its destination are all present.**

| Integration | Transport (choose one) | Credential | Destination |
| --- | --- | --- | --- |
| GitHub | `MCP_GITHUB_URL` (streamable HTTP) **or** `MCP_GITHUB_COMMAND` + `MCP_GITHUB_ARGS` (JSON array; stdio) | `MCP_GITHUB_TOKEN` (sent as bearer, or passed to the stdio process as `GITHUB_PERSONAL_ACCESS_TOKEN`) | `GITHUB_REPO=owner/name` |
| Jira | `MCP_JIRA_URL` **or** `MCP_JIRA_COMMAND` + `MCP_JIRA_ARGS` | `MCP_JIRA_TOKEN` (Atlassian documents API-token access for its remote server) plus `JIRA_SITE_URL` when the server needs it | `JIRA_PROJECT_KEY` |
| Notion | `MCP_NOTION_COMMAND` + `MCP_NOTION_ARGS` (default suggestion: `npx -y @notionhq/notion-mcp-server`, still maintained) **or** `MCP_NOTION_URL` | `MCP_NOTION_TOKEN` (internal integration token; passed as `NOTION_TOKEN`) | `NOTION_PARENT_PAGE_ID` |
| Slack | `MCP_SLACK_URL` **or** `MCP_SLACK_COMMAND` + `MCP_SLACK_ARGS` | `MCP_SLACK_TOKEN` (bot token) | `SLACK_CHANNEL_ID` |
| Google Drive | `MCP_GOOGLE_DRIVE_URL` **or** `MCP_GOOGLE_DRIVE_COMMAND` + `MCP_GOOGLE_DRIVE_ARGS` | Google OAuth (below) | `DRIVE_FOLDER_ID` |
| Gmail | `MCP_GOOGLE_GMAIL_URL` **or** `MCP_GOOGLE_GMAIL_COMMAND` + `MCP_GOOGLE_GMAIL_ARGS` | Google OAuth (below) | the owner's own mailbox (implicit) |
| Google (both) | | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | |
| Owner | | | `INTEGRATION_OWNER_USER_ID` (UUID from `POST /api/session` for the owner's device token) |

- **Google**: the token provider exchanges the refresh token for an access token at Google's token endpoint (one `fetch`, `grant_type=refresh_token`), caches it until 60 seconds before it expires, and supplies it as the bearer for the HTTP transports (or as the server's expected environment variable for stdio). A rejected exchange marks Google `rejected`. No consent screen is built; the operator obtains the refresh token once, outside the product.
- **Transport safety**: a URL must be `https:` (or `http://localhost` for a local server); a stdio command is run with a **minimal environment** (its own credential variables plus `PATH`), never the whole server environment, so one integration's process cannot read another's secrets or the database URL. The reference servers `@modelcontextprotocol/server-github`, `-slack`, and `-gdrive` are **deprecated** and are not defaults.
- **Nothing person-supplied reaches a transport definition** (FR-042): URLs, commands, and destinations come from the environment only.
- **Status** is recomputed on demand from the environment plus in-memory health: `missing` if any required variable is absent; `rejected` while an authentication failure is remembered (5 minutes); otherwise `connected`.
- **No secret ever appears** in a log, an error, a stored run, a response, or a prompt. Configuration is read at call time (like `agents/limits.ts`) so tests set sentinel secrets and scan for them.

## The MCP client (`src/actions/integrations/mcp-client.ts`)

- One lazily created SDK `Client` per integration on `globalThis`, connected over `StreamableHTTPClientTransport` or `StdioClientTransport`, reconnecting on failure. On connect it calls `tools/list` **once** and resolves each of our bindings to the first candidate name present (research 2); results are cached for 5 minutes.
- Each call: validate arguments (ours), map them (`toArguments`), `callTool` with the per-call timeout (15 s) and the run's abort signal, then `parseResult` extracts links and a short plain text. An MCP `isError` result or a transport error becomes a `ConnectorError` with a fixed code (401/403 or an "unauthorized" style failure is `rejected_credentials` and sets `rejected`; a timeout is `timed_out`; anything else is `service_error`).
- Only the configured **destination** is added by `toArguments`; there is no argument by which a call can choose another repository, channel, page, project, or folder (FR-033).
- A read tool's result is normalized to at most 8 items (title, URL, ≤ 160-char snippet); anything from a service is untrusted text (FR-040).

## Bindings (server tool candidates and argument mapping)

Each row: our tool id → candidate server tool names (first found wins) and how our inputs map. `+dest` = the configured destination is added by us. Best-effort, verify with the probe.

| Tool id | Candidate server tools | Mapping |
| --- | --- | --- |
| `github_create_issue` | `create_issue`, `issue_write` | `{ owner, repo, title, body }` +dest (`issue_write` uses `method: "create"`) |
| `github_create_gist` | `create_gist` | `{ filename, content, description, public: false }` |
| `github_search` | `search_issues`, `search_code` | `{ query: "repo:<dest> <query>" }` |
| `github_comment_on_issue` | `add_issue_comment` | `{ owner, repo, issue_number, body }` +dest |
| `jira_create_issue` | `createJiraIssue`, `jira_create_issue` | `{ projectKey, summary, description, issueTypeName }` +dest |
| `jira_search` | `searchJiraIssuesUsingJql`, `jira_search` | `{ jql: 'project = <dest> AND text ~ "<text>"' }` (text escaped) |
| `jira_add_comment` | `addCommentToJiraIssue`, `jira_add_comment` | `{ issueIdOrKey, commentBody }` |
| `notion_create_page` | `API-post-page`, `create_page` | `{ parent: { page_id: <dest> }, properties: { title }, children: paragraphs }` |
| `notion_append_blocks` | `API-patch-block-children`, `append_blocks` | `{ block_id: <page>, children: paragraphs }` |
| `notion_search` | `API-post-search`, `search` | `{ query }`; results outside the destination page are dropped |
| `slack_post_message` | `conversations_add_message`, `slack_post_message` | `{ channel_id: <dest>, text }` |
| `slack_upload_snippet` | `files_upload`, `slack_upload_snippet` | `{ channels: <dest>, filename, content, title }` |
| `drive_upload_markdown` | `create_file`, `drive_upload` | `{ name, mimeType: "text/markdown", content, parents: [<dest>] }` |
| `drive_create_doc_from_summary` | `create_doc`, `create_file` | `{ name, mimeType: "application/vnd.google-apps.document", content, parents: [<dest>] }` |
| `drive_get_share_link` | `get_file`, `get_file_metadata` | `{ fileId }` → the `webViewLink`; **no permission is created or changed** |
| `gmail_create_draft` | `create_draft` | `{ to?, subject, body }` |
| `gmail_send_message` | `send_message`, `send_email` | `{ to, subject, body }` (called only from the confirm route) |
| `gmail_search_messages` | `search_messages`, `search_threads` | `{ query, maxResults: 5 }` → sender, subject, date, excerpt; **not stored, not given to the AI** |

The Slack and Notion rows carry the least documentation certainty (Slack's official server is OAuth-first and hosted; the community and stdio alternatives vary), so they are the first two probe tasks. If a real server cannot be made to work with a static credential for one integration, the documented pivot is a **REST connector for that integration behind the same `ToolConnector` seam** (research 2), which changes no other file.

## Probe and live checks (opt-in, never in CI)

- `ACTIONS_LIVE_<NAME>=1` (`GITHUB`, `JIRA`, `NOTION`, `SLACK`, `GOOGLE`): connect, call `tools/list`, and report which of our bindings resolve, which candidates were found, and any server tool we do not map. **It never calls a write tool and never reads mail.** Used to adjust bindings.
- `ACTIONS_LIVE=1`: the suggestion pass and one composed local run against the active AI provider on fixture tabs (timing for SC-001 and SC-004). Paced for the backup provider's 15 requests a minute.

## Tests for this contract

1. **Protocol**: the real SDK client against a fake MCP server (in-memory transport) exposing some, all, or none of each binding's candidates: resolution, unavailable-when-absent, per-tool argument mapping, `+dest` always added and never overridable, timeout, `isError` mapping, auth failure to `rejected`, minimal stdio environment (the spawned command's environment is inspected via a fake spawner), no secret in any error or log.
2. **Rules**: the scripted fake connector for run-level tests (record what it was asked; assert exact requests and results).
3. **Google token**: the exchange (against a fake token endpoint) caches, refreshes before expiry, and a failed exchange marks Google `rejected`.
