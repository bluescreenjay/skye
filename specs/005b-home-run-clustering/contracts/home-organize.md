# Contract: Home organize control (005b)

Consumes the shipped clustering API. Full HTTP details: [`specs/004-ai-clustering/contracts/http.md`](../../004-ai-clustering/contracts/http.md).

## Call

| Item | Value |
| --- | --- |
| Method / path | `POST /api/cluster/runs` |
| Auth | `Authorization: Bearer {VITE_DEVICE_TOKEN}` (same as Home directory GETs) |
| Body | `{}` or omit; default `force: false` |
| Success | HTTP `200` JSON per 004 (`skipped`, `run`, `applied`, `suggestions`, `leftOut`) |
| Then | `GET /api/workspaces` + `GET /api/tab-refs` (existing Home load) and recompose |

## Client handling (required)

| Server outcome | Home MUST |
| --- | --- |
| `200`, applied groups | Refresh directory; show quiet success or clear running state |
| `200`, `skipped: true` or nothing applied | Keep prior directory; show “nothing to organize” (or equivalent) |
| `401` / empty config | Failure copy; empty or prior directory; **no** dummy seed |
| `409` `run_in_progress` | Explain already organizing; do not corrupt directory |
| `429` / `502` / `503` / network | Short failure copy; chrome intact |

## Explicitly out of contract for 005b

- Rendering `suggestions[]` as an accept/ignore list
- `POST /api/suggestions/...`
- `POST /api/cluster/runs/:id/undo`
- Side Panel, command bar, create-workspace UI
- Calling any LLM from the extension

## UI contract (minimal)

- One control, lowercase label such as `organize`
- Disabled or no-op while `running`
- Status/failure text adjacent; does not replace rail + cards layout
