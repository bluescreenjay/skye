# Quickstart: Workspace Persistence API (003)

Proves pairing, durable workspaces, tab membership, resolve, and events — without Home/Sidebar UI.

## Prerequisites

- Feature 001 packages installed (`pnpm install`)
- Postgres reachable (`DATABASE_URL` in `.env`)
- `DEVICE_TOKEN_SECRET` set in `.env` (any long random string; not a user token)

```bash
psql "$DATABASE_URL" -f packages/shared/sql/001_init.sql
# Ignore "already exists" if 001 was applied before
```

## Run API

```bash
pnpm --filter @ai-browser/web dev
```

## Pair two clients (Home vs Sidebar)

```bash
export T1=home-token-aaaaaaaa
export T2=sidebar-token-aaaaaaaa   # SAME value as T1 to share a user
export T3=other-person-bbbbbbbb

curl -s -X POST http://localhost:3000/api/session \
  -H 'content-type: application/json' \
  -d "{\"deviceToken\":\"$T1\"}"
# → userId U1

curl -s -X POST http://localhost:3000/api/session \
  -H 'content-type: application/json' \
  -d "{\"deviceToken\":\"$T3\"}"
# → different userId
```

## Workspaces survive “restart”

```bash
curl -s -X POST http://localhost:3000/api/workspaces \
  -H "Authorization: Bearer $T1" -H 'content-type: application/json' \
  -d '{"name":"Hackathon","emoji":"💻"}'
# save workspace id as WID

curl -s http://localhost:3000/api/workspaces -H "Authorization: Bearer $T1"
# includes Hackathon

# Restart the Next server, then:
curl -s http://localhost:3000/api/workspaces -H "Authorization: Bearer $T1"
# same list

curl -s http://localhost:3000/api/workspaces -H "Authorization: Bearer $T3"
# does not include Hackathon
```

## Tabs and Other

```bash
curl -s -X PUT http://localhost:3000/api/tab-refs \
  -H "Authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"url\":\"https://github.com\",\"title\":\"GitHub\",\"chromeTabId\":1,\"workspaceId\":\"$WID\"}"

curl -s -X PUT http://localhost:3000/api/tab-refs \
  -H "Authorization: Bearer $T1" -H 'content-type: application/json' \
  -d '{"url":"https://youtube.com","title":"YouTube","chromeTabId":2,"workspaceId":null}'
```

## Resolve (sidebar)

```bash
curl -s "http://localhost:3000/api/resolve?chromeTabId=1" \
  -H "Authorization: Bearer $T1"
# workspace id == WID

curl -s "http://localhost:3000/api/resolve?chromeTabId=2" \
  -H "Authorization: Bearer $T1"
# workspace null (Other)

curl -s "http://localhost:3000/api/resolve?url=https://github.com" \
  -H "Authorization: Bearer $T2"
# same user as T1 if T2 === T1
```

## Events

```bash
curl -s -X POST http://localhost:3000/api/tab-events \
  -H "Authorization: Bearer $T1" -H 'content-type: application/json' \
  -d "{\"eventType\":\"reassigned\",\"url\":\"https://github.com\",\"chromeTabId\":1,\"workspaceId\":\"$WID\"}"

curl -s http://localhost:3000/api/tab-events -H "Authorization: Bearer $T1"
```

## Fail if

- Unauthenticated list returns 200 with another user’s workspaces
- Restart loses workspaces
- `create_hypertable` is required to pass these curls
- Home or Side Panel UI was built in this feature

Contract: [contracts/http.md](./contracts/http.md)
