# AI Browser

Chrome extension (Home + Side Panel) + Next.js server that turns tabs into workspaces. TypeScript monorepo: `apps/extension/`, `apps/web/`, `packages/shared/`.

This repo is driven by **Spec Kit**. Follow its workflow rather than improvising.

## Source of truth (read before planning or coding)

- `.specify/memory/constitution.md` — binding principles. If a change conflicts with it, stop and flag it; don't work around it.
- `FEATURES.md` — ordered feature checklist. MVP cut line is 001–011; don't start P1/stretch work before it ships.
- `tech-stack.txt` — preferred stack and pivots. `initialspec.txt` — original product spec.
- `specs/<NNN-feature>/` — the active feature's `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/`, `quickstart.md`, `tasks.md`. The current feature is the one matching the git branch (e.g. `001-shared-domain-model`).

## Workflow

Spec Kit skills live in `.cursor/skills/` and are symlinked at `.claude/skills/` so both Cursor and Claude Code use one copy.

`/speckit-constitution` → `/speckit-specify` → `/speckit-clarify` → `/speckit-plan` → `/speckit-tasks` → `/speckit-analyze` → `/speckit-implement`

- Use the matching skill for each phase; don't write specs, plans, or tasks by hand outside them.
- Implement from `specs/<feature>/tasks.md`: in order, respecting `[P]` and phase dependencies, checking tasks off as they complete.
- Don't change `spec.md`, `plan.md`, or `data-model.md` mid-implementation without flagging it. If reality contradicts them, stop and say so.
- Validation for feature 001 is `tsc --noEmit` per `quickstart.md`; don't add test tasks the spec doesn't request.
- Keep specs about *what/why*; put stack detail in the plan.

## Stop Conditions
- Any `git commit`, `git push`, or other write to shared/external state → stop, ask first.
- Destructive ops (rm, force push, etc) → stop, ask.

### Spec Kit git hooks

`.specify/extensions.yml` has `auto_execute_hooks: true`, with hooks that run `speckit.git.commit` before clarify/plan/tasks/implement (and `speckit.git.feature` before specify). The **Stop Conditions above override these hooks**: don't auto-run a commit or branch creation because a hook says to — ask first, then run it if approved.
