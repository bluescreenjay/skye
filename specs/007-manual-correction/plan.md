# Implementation Plan: Manual Workspace Correction

**Branch**: 007-manual-correction | **Date**: 2026-09-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from specs/007-manual-correction/spec.md

## Summary

Finish manual correction across Home and the Side Panel: create workspaces on Home (drag/rename already exist), move or recategorize the active page from the sidebar, dismiss soft suggestions, keep writing `placementSource: "user"` and correction rows so clustering never overrides those choices, and apply Chrome tab groups so open eligible tabs match durable workspace membership.

## Technical Context

**Language/Version**: TypeScript (strict), Node.js 22+, React 19, Chrome Manifest V3

**Primary Dependencies**: Existing 003 workspace/tab-ref HTTP API; 004 `placementSource` + suggestions ignore/accept; Chrome `tabs.group` / `tabGroups.update`; shared `Correction` / `Workspace` / `TabRef` types

**Storage**: Existing Tiger/Postgres `workspaces`, `tab_refs` (with `placement_source`), `corrections`, `suggestions`; small schema extension only if correction kinds beyond moves must be persisted explicitly

**Testing**: Vitest for correction recording, clustering skip of user-placed tabs, group-apply mapping, and Home/Sidebar client helpers; extension build/typecheck; manual Chrome walkthrough for drag, sidebar move, and visible tab groups

**Target Platform**: Chrome 116+ desktop (tab groups + Side Panel)

**Project Type**: Chrome extension UI + Next.js API (mostly reuse; extension gains write + apply-groups behavior)

**Performance Goals**: Sidebar assignment update visible within 2 seconds for 95% of local trials when the API is available; Chrome group sync completes shortly after a successful save without blocking the UI on failure messaging

**Constraints**: Server remains authority for membership; no ML retraining; no client-only workspaces; observe-only ingest modules stay read-only—apply-groups lives in an explicit UI/apply module; Home stays the cross-workspace organizer; sidebar only corrects the active page

**Scale/Scope**: One paired user, modest workspace counts for demo, open HTTP(S) tabs only for Chrome sync

## Constitution Check

*Gate evaluated before Phase 0 research. Rechecked after Phase 1 design.*

| Principle | Result | Design consequence |
| --- | --- | --- |
| I. Workspace-First | PASS | Corrections mutate durable workspaces and tab refs; Chrome groups are a projection, not the source of truth. |
| II. Extension Observes and Presents; Server Decides | PASS | Extension applies server-confirmed assignments via tab groups; it does not invent clustering. |
| III. User Corrections Win | PASS | This feature is the principle: `placementSource: "user"` already blocks 004 apply; UI completes the loop. |
| IV. Least-Power Actions | PASS | Native Chrome tab groups; no computer-use agent. |
| V. One TypeScript Surface | PASS | Shared Correction/Workspace/TabRef; shared move helpers where Home and Sidebar both write. |
| VI. Demo-Hard, Architecture-Soft | PASS | Reuse 003/004 routes; add thin create + sidebar move + group sync. |
| VII. Two Surfaces | PASS | Home: cross-workspace drag/create/rename; Sidebar: active-page move + dismiss. |

No constitution exceptions.

## Phase 0: Research

Decisions are recorded in [research.md](research.md). Key choices: reuse existing PATCH/POST workspace and tab-ref routes (already set `placementSource: "user"` and insert `corrections`); treat suggestion ignore as dismiss feedback; use Chrome tab groups titled with the workspace name; gate apply-groups behind `tabGroups` permission in a dedicated module so ingest stays observe-only.

## Phase 1: Design

- [data-model.md](data-model.md) maps durable entities and Chrome projection state.
- [contracts/corrections.md](contracts/corrections.md) documents Home/Sidebar write flows, reuse of 003/004 HTTP, and group sync behavior.
- [quickstart.md](quickstart.md) validates drag, create, sidebar move, organize-does-not-clobber, and Chrome groups.

## Project Structure

### Documentation (this feature)

~~~text
specs/007-manual-correction/
├── plan.md
├── research.md
├── data-model.md
├── contracts/corrections.md
├── quickstart.md
└── checklists/requirements.md
~~~

### Source Code (repository root)

~~~text
apps/extension/
├── manifest.config.ts              # add tabGroups permission
├── src/home/                       # create-workspace control; keep drag/rename
├── src/sidebar/                    # active-tab move + suggestion dismiss
├── src/apply-groups.ts             # map workspaces → chrome.tabs.group / tabGroups.update
├── src/background.ts               # optional: re-sync groups after ingest settle
└── tests/                          # move helpers, group mapping, observe-only allowlist
apps/web/app/api/
├── workspaces/                     # existing POST/PATCH
├── tab-refs/[id]/                 # existing PATCH (+ corrections)
└── suggestions/[id]/ignore/       # existing dismiss
packages/shared/
├── src/domain.ts                   # Correction (extend kind only if needed)
└── sql/007_*.sql                   # only if correction kinds need new columns
~~~

**Structure Decision**: Prefer extension UI + Chrome apply layer on top of existing 003/004 APIs. Avoid new membership endpoints. Add schema only if rename/create/dismiss cannot be represented with current `corrections` + `suggestions` rows.

## Complexity Tracking

> None — no constitution violations.

## Post-Design Constitution Check

All seven gates still pass. The design reuses server placement rules, adds Chrome tab-group projection under an explicit apply module, and keeps Home vs Sidebar responsibilities split per Principle VII.
