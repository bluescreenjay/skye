# Contract: environment variables

Committed file: repository-root `.env.example`  
Gitignored: `.env`, `.env.local`, `apps/*/.env*`

No live keys in git.

| Variable | Required in 001 | Purpose | Pivot notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | Example only | Postgres connection (Tiger preferred) | Supabase: project URI + `sslmode=require` |
| `GEMINI_API_KEY` | Example only | Later clustering/chat/actions | Or `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` |
| `ELEVENLABS_API_KEY` | Optional example | Later desktop voice (013) | Omit / use Web Speech |
| `DEVICE_TOKEN_SECRET` | Example only | Hash device pairing tokens later | Unused until 003 |

This feature MUST NOT read these at runtime except optionally to document them. Blank values are expected on a fresh clone.
