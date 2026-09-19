# Repository Guidelines

## Project Structure & Module Organization

This pnpm monorepo contains `apps/extension/` (Chrome Manifest V3 extension and Home page), `apps/web/` (Next.js App Router API), and `packages/shared/` (shared types, domain logic, and SQL migrations). Application source lives in each app's `src/`; web routes live in `apps/web/app/api/`. Tests are under each app's `tests/`, extension images under `apps/extension/public/`, and feature specifications under `specs/<NNN-feature>/`. Read `FEATURES.md` and the relevant feature spec before changing behavior.

## Build, Test, and Development Commands

Use Node 22 or newer and pnpm 9. Install dependencies with `pnpm install`.

- `pnpm --filter @ai-browser/web dev`: run the local API on port 3000.
- `pnpm --filter @ai-browser/extension build`: produce the loadable extension in `apps/extension/dist/`.
- `pnpm build`: build all workspace packages.
- `pnpm typecheck`: run TypeScript checks across the workspace.
- `pnpm --filter @ai-browser/web test` and `pnpm --filter @ai-browser/extension test`: run each app's Vitest suite.

## Coding Style & Naming Conventions

Use TypeScript with the repository's strict compiler settings and existing two-space indentation. Follow nearby code for import order and formatting; no dedicated formatter or linter script is configured. Use lowercase, hyphenated filenames for modules (for example, `domain-check.ts`), `*.test.ts` for tests, and Next.js `route.ts` files for API endpoints. Keep wire types and shared domain rules in `packages/shared/` rather than duplicating them in apps.

## Testing Guidelines

Add or update Vitest tests alongside behavior changes. Extension tests live in `apps/extension/tests/`; web tests live in `apps/web/tests/`, including `tests/e2e/`. Web tests use an in-process PGlite database, so the normal suite does not need a running Postgres server. Run both app suites and `pnpm typecheck` before opening a PR. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short, descriptive subjects, sometimes prefixed with a feature number (for example, `002 - tab ingestion for extension`). Use an imperative summary that names the affected feature. In PRs, describe the behavior change, link the relevant `specs/<NNN-feature>/` work or issue, list verification commands, and include screenshots for Home or other UI changes.

## Configuration & Secrets

Use `.env.example` and `apps/extension/.env.example` as setup references. Never commit `.env` files or `apps/extension/dist/`: the extension build embeds its device token. Keep `DATABASE_URL`, `DEVICE_TOKEN_SECRET`, and `GEMINI_API_KEY` server-side.
