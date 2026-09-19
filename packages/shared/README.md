# @ai-browser/shared

The single canonical TypeScript definition of the AI Browser domain. The
extension and the web app import from here and must not redeclare these types.

Types live in [`src/domain.ts`](./src/domain.ts) and are re-exported from
`src/index.ts`. The Postgres schema for them is
[`sql/001_init.sql`](./sql/001_init.sql).

| Entity | What it is |
| --- | --- |
| `User` | Owner of everything durable; identified by a hashed device pairing token. |
| `Workspace` | A durable, named unit of work. It is a record in its own right, not "the open tabs", and survives with zero tabs. |
| `TabRef` | A tab's URL, title and snippet, and which workspace it belongs to. `workspaceId: null` means **Other**. |
| `TabEvent` | Append-only tab lifecycle event (`opened`, `updated`, `activated`, `closed`, `reassigned`). |
| `PlanItem` | A plan step for a workspace (populated in feature 009). |
| `Message` | A chat message in a workspace (feature 008). |
| `ActionRun` | One execution of a workspace action (feature 010). |
| `Correction` | A user move of a tab between workspaces or to Other (feature 007). |

Every durable entity except `User` carries `userId`.

Names are camelCase in TypeScript and snake_case in SQL (`userId` ↔ `user_id`).

## Commands

```bash
pnpm --filter @ai-browser/shared typecheck
pnpm --filter @ai-browser/shared build
```
