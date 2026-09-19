# Quickstart: Shared Domain Model (001)

Validates the foundation without product UI, a live database, or AI calls.

## Prerequisites

- Node.js 22+
- pnpm 9+
- Git clone of this repo on branch `001-shared-domain-model`

Tiger/Gemini accounts are **not** required to pass 001.

## Setup

```bash
cd /path/to/ai_browser
pnpm install
cp .env.example .env   # leave values blank
```

## Validate

```bash
pnpm -r typecheck
# or, if scripts are named build:
pnpm --filter @ai-browser/shared build
```

Expected:

- `@ai-browser/shared` emits types for User, Workspace, TabRef, TabEvent, PlanItem, Message, ActionRun, Correction
- `apps/web` and `apps/extension` compile while importing those types
- No Home, Side Panel, clustering, or chat UI

Spot-check contracts:

- Types: [contracts/shared-types.md](./contracts/shared-types.md)
- SQL: [contracts/001_init.sql](./contracts/001_init.sql) (apply later in 003; optional `psql "$DATABASE_URL" -f packages/shared/sql/001_init.sql` if a DB exists)
- Env: [contracts/env.md](./contracts/env.md)

## Fail if

- Either app redefines domain types locally
- `.env` with real keys is committed
- Newtab Home or Side Panel is implemented in this feature
