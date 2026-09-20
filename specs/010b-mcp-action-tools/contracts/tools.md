# Contract: The tool catalog (server side only)

30 tools: 12 local and 18 through MCP connections. Every one has an id, a one-line description (given to the suggestion pass, never shown as a list to the person, FR-002), an input schema, an effect class, and a fake-executor test (SC-007). This table is the spec's FR-018 and FR-031 made concrete; ids come from the feature's own specify prompt.

**Effect classes**: `read` changes nothing anywhere. `write` creates or changes something (in the workspace, the browser, or a service). `send` reaches another person (email only). **Helper** = a `read` tool the click loop may call besides the button's own tool; the helper set is exactly the five tools marked **H** and a test pins it (research 12).

**Argument flags**: `visible` = must be present in the suggestion's prefill or the click's body (never model-composed at click time, research 6). `target` = validated as described. Text limits are refusals, not cuts (research 13).

**Result** names the `ToolResult` kind ([shared-types.md](./shared-types.md)). **AI on click**: `0` = a direct run makes no AI request; `loop` = a composed run may use up to 4 (research 7); `1` = the tool owns exactly one AI request (`write_summary`).

## Local tools (no third-party account)

| Tool id | Effect | H | Inputs | Preconditions (else not suggested; forced = plain refusal) | Result | AI on click |
| --- | --- | --- | --- | --- | --- | --- |
| `list_workspace_tabs` | read | **H** | none | the workspace | `text` (title, plain address, excerpt ≤ 200, at most 40 tabs, only this workspace) | 0 |
| `read_public_pages` | read | **H** | `tabs`: short ids (`t1`…) from the listing, at most 8 | the workspace has web tabs | `text` (per page: read text ≤ 4,000 chars, or the fixed reason category; safe reader from 010: `https` public addresses only, no query string or fragment, honest note per unread page) | 0 |
| `write_summary` | write | | none | the workspace has web tabs | `summary` (saved to the workspace; shows what it covers) | **1** |
| `export_summary_markdown` | write | | none | a saved summary exists | `file` (download intent `md`) | 0 |
| `export_summary_pdf` | write | | none | a saved summary exists | `file` (download intent `pdf`) | 0 |
| `open_related_tabs` | write | | `urls` (**visible**, 1 to 5 `https` public addresses), `placeInWorkspace` (bool, default false) | the workspace | `opened` (browser intent; skipped addresses listed with a fixed reason) | 0 (never composed) |
| `open_google_searches` | write | | `queries` (**visible**, 1 to 3, each 3 to 120 chars), `placeInWorkspace` (bool) | the workspace | `opened` (browser intent; the server builds the Google search addresses) | 0 (never composed) |
| `save_search_queries` | write | | `queries` (1 to 5, each 3 to 120 chars) | the workspace, fewer than 10 saved | `saved` (added, duplicates skipped, refused over the cap) | loop (0 if `queries` prefilled) |
| `append_plan_items` | write | | `items` (1 to 8, each 1 to 200 chars) | the workspace, fewer than 30 items | `saved` | loop (0 if prefilled) |
| `save_refs` | write | | `refs`: `[{ quote 10 to 300 chars, tab: short id }]`, at most 10; each quote is verified against its tab's material | the workspace has web tabs | `saved` (refused = quotes not found) | loop (0 if prefilled) |
| `copy_text` | read | | `text` (1 to 8,000): defaults to the saved summary when omitted | a saved summary exists, or `text` given | `copy` (the card offers **Copy**) | 0 |
| `compose_share_link` | read | | none | a saved summary exists | `text` (workspace name, up to 5 key plain addresses, summary blurb ≤ 300 chars; nothing else) | 0 |

Notes:

- "Loop (0 if prefilled)": with every required argument present the run is direct (0 AI requests); with gaps it is composed (research 6).
- `write_summary` has no inputs to fill, so it is never composed: it runs the 010 summarize pipeline (one AI request) and saves the text.
- The Other bucket (`workspaceId = other`) is refused for every tool (FR-039).
- All list/reads filter by `user_id` and the workspace id (FR-019, FR-038).

## GitHub (team tool, one shared account; destination `GITHUB_REPO` = `owner/name`)

| Tool id | Effect | H | Inputs | Result and link |
| --- | --- | --- | --- | --- |
| `github_create_issue` | write | | `title` (1 to 200), `body` (1 to 8,000) | `created`; issue number and URL |
| `github_create_gist` | write | | `filename` (1 to 80, plain name), `content` (1 to 20,000), `description` (0 to 200); **secret** gist, never public | `created`; gist URL |
| `github_search` | read | **H** | `query` (3 to 200), `kind`: `issues` or `code` (default `issues`), limited to the configured repository | `search` (up to 8: title, URL, ≤ 160-char snippet); changes nothing |
| `github_comment_on_issue` | write | | `issue` (**target**: a positive whole number, in the configured repo), `body` (1 to 3,000) | `created`; comment URL |

## Jira (team tool; site and token; destination `JIRA_PROJECT_KEY`)

| Tool id | Effect | H | Inputs | Result and link |
| --- | --- | --- | --- | --- |
| `jira_create_issue` | write | | `summary` (1 to 200), `description` (0 to 8,000), `type` (default `Task`) | `created`; key and browse URL |
| `jira_search` | read | **H** | `text` (3 to 200); searched inside the configured project only | `search` (up to 8: key, summary, URL) |
| `jira_add_comment` | write | | `key` (**target**: `<PROJECT>-<n>`), `body` (1 to 3,000) | `created`; issue URL |

## Notion (team tool; integration token; destination `NOTION_PARENT_PAGE_ID`)

| Tool id | Effect | H | Inputs | Result and link |
| --- | --- | --- | --- | --- |
| `notion_create_page` | write | | `title` (1 to 200), `content` (0 to 8,000, plain paragraphs) | `created`; page URL and id (usable as a later target) |
| `notion_append_blocks` | write | | `page` (**target**: id from an earlier successful `notion_create_page` run in this workspace), `content` (1 to 8,000) | `created`; page URL |
| `notion_search` | read | **H** | `text` (3 to 200); results outside the configured parent are dropped | `search` (up to 8: title, URL) |

## Slack (team tool; bot token; destination `SLACK_CHANNEL_ID`)

| Tool id | Effect | H | Inputs | Result and link |
| --- | --- | --- | --- | --- |
| `slack_post_message` | write | | `text` (1 to 3,000) | `created`; "posted to the configured channel" with a permalink when the server returns one |
| `slack_upload_snippet` | write | | `filename` (1 to 80), `content` (1 to 20,000), `title` (0 to 200) | `created`; snippet link when returned |

## Google (owner only; the owner's account; destination `DRIVE_FOLDER_ID` and the owner's own mailbox)

| Tool id | Effect | H | Inputs | Result and link |
| --- | --- | --- | --- | --- |
| `drive_upload_markdown` | write | | `filename` (1 to 80, `.md` appended when missing); content is the **saved summary** (a summary must exist) | `created`; file link and id |
| `drive_create_doc_from_summary` | write | | `title` (1 to 200); content is the **saved summary** | `created`; document link and id |
| `drive_get_share_link` | read | | `file` (**target**: id from an earlier successful Drive run in this workspace) | `created` (link only); **does not change who can access** the item (FR-037) |
| `gmail_create_draft` | write | | `subject` (1 to 200), `body` (1 to 8,000), `to` (optional: one valid address) | `created`; "draft saved", with the draft link when returned; **sends nothing** |
| `gmail_send_message` | **send** | | `subject`, `body`, `to` (optional at click; required at confirm) | **two-phase**: the click ends with `email_preview` (nothing sent); `POST …/confirm` sends the stored message once (research 8) |
| `gmail_search_messages` | read | (not a helper) | `text` (3 to 200) | `mail_search`: inline, **ephemeral** (up to 5 messages; sender, subject, date, ≤ 160-char excerpt), shown to the owner in the click's response only; never stored, never given to the AI, never saved (research 9) |

Notes:

- **Drive and Gmail are `ownerOnly`**. For anyone else they are excluded from suggestions and refused as `not_available`; for the owner with Google missing or rejected, they are excluded and refused as `not_connected` ("Connect Google") (spec User Story 7 scenarios 6 and 7).
- **Writes go only to the configured destination** (FR-033). No tool accepts a repository, channel, project, parent page, or folder as an argument.
- **Searches never change anything** (FR-034); `read` tools are the only ones the loop may run, and only the five helpers among them.
- **Nothing here deletes or edits existing items** (spec Out of scope): the only "change" tools add a comment or append content to something this workspace's own earlier run created.
- **Secrets** never appear in an input, a result, a step note, or an error (FR-041).
