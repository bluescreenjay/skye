# Research: Home → run clustering

## 1. How Home starts a cluster run

- **Decision**: On organize click, `POST {apiBaseUrl}/api/cluster/runs` with `Authorization: Bearer {VITE_DEVICE_TOKEN}` and body `{}` (default `force: false`). On HTTP success, call existing `loadDirectory()` and recompose Home. Do not poll; 004 is synchronous.
- **Rationale**: Spec FR-002/003; 004 contract already defines the run. Force is unnecessary for the first demo click; user can click again, or we add force later if “unchanged” skips too often.
- **Alternatives considered**: Auto-run on every Home mount (surprising, burns Gemini budget). `force: true` always (extra cost; skip only when useful). `GET /api/overview` instead of separate GETs after run (nice later; not required—005 already uses workspaces + tab-refs).

## 2. Mapping HTTP outcomes to Home copy

- **Decision**: Client helper maps:
  - `200` + `skipped: false` + non-empty `applied` → success; refresh directory
  - `200` + `skipped: true` or empty `applied`/`suggestions` with no change → “nothing to organize” (or similar), keep directory
  - `409` `run_in_progress` → “already organizing”
  - `401` / misconfigured token → pairing failure copy; no dummy cards
  - `503` `model_unconfigured` / `429` / `502` → short service failure copy
  - Network throw → same quiet failure, keep chrome
- **Rationale**: Spec US2 and FR-006; 004 status codes are stable.
- **Alternatives considered**: Toast-only with no copy (fails “readable failure”). Surface full suggestions list (out of scope FR-007/009).

## 3. UI chrome placement

- **Decision**: One lowercase control labeled like `organize` near the greeting / home-top region (or a restrained spot that does not add a second hero). Disable or ignore re-entry while `running`. Status text beside or under the control.
- **Rationale**: FR-001/008 — minimal vs mock. Avoid new dashboard chrome.
- **Alternatives considered**: Floating FAB (anti-mock). Put organize only in expanded card actions (wrong: organize is global, not per-workspace).

## 4. Timeout / navigate-away

- **Decision**: Leave the in-flight `fetch` alone if the user closes Home; next open loads directory from server (004 already committed apply before response). Show running until settle or error; no client-side abort required for MVP.
- **Rationale**: Spec edge case; server is source of truth after apply.
- **Alternatives considered**: AbortController on unmount (optional polish, not required).

## 5. Schema / Gemini prerequisites

- **Decision**: Document in quickstart that 004 SQL (`004_clustering.sql`) and `GEMINI_API_KEY` must already be applied—005b does not migrate or configure the model.
- **Rationale**: FEATURES depends on 004+005.
- **Alternatives considered**: Bundling migration into 005b (wrong feature ownership).

## Clarifications

None remaining from Technical Context. `force` default and control placement are decided above.
