# AI Daily News Digest

Collects news from RSS Sources, groups Articles about the same real-world event with Gemini, writes
Vietnamese summaries, and emails one Daily Digest at 07:00 JST (Asia/Tokyo) for the previous JST day.

- `apps/web`: React, Vite, Tailwind CSS
- `apps/server`: Fastify API + pg-boss workers (one process)
- `packages/contracts`: shared API contracts (zod)
- `packages/domain`: framework-free domain rules

Specifications: `docs/product-spec-v1.1.md`, `docs/technical-spec-v1.1.md`.
Production deployment: **[docs/deployment.md](docs/deployment.md)**.

## Local development

Requirements: Node.js 22, pnpm 10 (through Corepack), Docker (for PostgreSQL).

```bash
docker compose up -d postgres          # PostgreSQL on 127.0.0.1:5433
cp .env.example .env                   # then fill in DATABASE_URL, SESSION_SECRET, ADMIN_*, keys
corepack pnpm install
corepack pnpm --filter @aidnd/server migrate
corepack pnpm --filter @aidnd/server admin:create
corepack pnpm dev                      # API on :3000, web on http://localhost:5173 (proxies /api)
```

Sign in at `http://localhost:5173/login`. Locally the in-process scheduler (05:30 collect, 06:00/06:30
draft, 06:45 finalize, 07:00 send, all JST) runs while the server is up. Set
`DIGEST_SCHEDULER_ENABLED=false` to disable it.

Useful commands:

```bash
corepack pnpm typecheck                # build packages + tsc --noEmit everywhere
corepack pnpm build                    # production build (web bundle + server dist)
corepack pnpm test                     # unit + PostgreSQL integration tests (FakeAIProvider / FakeEmailProvider)
corepack pnpm --filter @aidnd/server ai:smoke                    # manual real-Gemini check
corepack pnpm --filter @aidnd/server digest:run -- --date YYYY-MM-DD [--deliver]
corepack pnpm --filter @aidnd/server articles:backfill-language -- --dry-run
```

Integration tests create and drop a temporary schema in `TEST_DATABASE_URL` (or `DATABASE_URL`).
They never use real Gemini or Resend.

## Production architecture

```text
GitHub (main) → Render Web Service (Docker, Free) → Neon PostgreSQL
                  └ Fastify API + pg-boss workers + React app in one container
                  └ Gemini API, Resend (news@buiduyanh.io.vn)
Cron-job.org → POST /api/v1/internal/cron/daily-digest (Bearer token), every 10 min 05:00–07:50 JST
GitHub Actions → daily encrypted pg_dump backup, 14-day retention
```

Render Free sleeps after ~15 idle minutes, so in production the external Cron trigger is the
scheduler (`DIGEST_SCHEDULER_ENABLED=false`). Each call wakes the app and enqueues whatever is due
according to the JST clock. Calls are idempotent: at most one Digest and one email per date.

See [docs/deployment.md](docs/deployment.md) for:

- environment variables (required / optional / provisioning-only / deprecated)
- Neon setup, migrations and admin provisioning against Neon
- Render setup, health checks, custom domain and HTTPS
- Cron-job.org configuration (Asia/Tokyo, or the UTC equivalent)
- the first controlled production email and when to enable automation
- backup and restore procedure, plus the restore test
- the security checklist

### Docker image

```bash
docker build -t aidnd .
docker run --rm -p 10000:10000 -e PORT=10000 -e DATABASE_URL=... -e SESSION_SECRET=... \
  -e CORS_ORIGIN=https://digest.buiduyanh.io.vn aidnd
```

The image contains no `.env` or secrets and runs as the non-root `node` user. Configuration comes
only from environment variables.

### Health checks

- `GET /health` → `200 {"status":"ok"}` (liveness; Render health check)
- `GET /ready` → `200 {"status":"ready"}` when PostgreSQL, pg-boss and the latest migration are
  available; `503` otherwise

## Security notes

- Secrets (Gemini/Resend keys, database URL, session secret, cron token) are server-side only.
  They are never logged, returned by the API, bundled into the web app, copied into the image or
  committed.
- Passwords are stored only as Argon2id hashes. Login is rate limited (5 per 15 minutes).
- The session cookie is `HttpOnly; SameSite=Lax`, plus `Secure` in production. Every mutation
  requires the CSRF double-submit token (`GET /api/v1/auth/csrf` → `X-CSRF-Token`).
- CORS allows exactly one origin; production requires `https://` and rejects `*`.
- The cron endpoint needs `Authorization: Bearer <CRON_TRIGGER_TOKEN>` (constant-time compare) and
  is disabled (404) when no token is configured.
