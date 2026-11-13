# AI Daily News Digest --- Developer Onboarding

This guide is for a new developer who wants to clone and run an
independent instance.

## 1. Clone

``` bash
git clone https://github.com/Buiduyanh20/AIDailyNewsDigest.git
cd AIDailyNewsDigest
```

## 2. Enable Corepack

``` bash
corepack enable
corepack pnpm --version
```

Use pnpm through Corepack.

## 3. Install

``` bash
corepack pnpm install
```

## 4. Create `.env`

PowerShell:

``` powershell
Copy-Item .env.example .env
code .env
```

macOS/Linux:

``` bash
cp .env.example .env
```

The real `.env` is ignored by Git.

## 5. Local environment

Fill the template with your own credentials:

``` env
NODE_ENV=development
PORT=3000
DATABASE_URL=<YOUR_DATABASE_URL>
SESSION_SECRET=<YOUR_LOCAL_SECRET>
CORS_ORIGIN=http://localhost:5173

GEMINI_API_KEY=<YOUR_GEMINI_API_KEY>
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_TIMEOUT_MS=30000

AI_CANDIDATE_WINDOW_HOURS=72
AI_MAX_CANDIDATES=8

EMAIL_PROVIDER=resend
RESEND_API_KEY=<YOUR_RESEND_API_KEY>
EMAIL_FROM=<YOUR_VERIFIED_SENDER>
EMAIL_TIMEOUT_MS=15000

CRON_TRIGGER_TOKEN=<YOUR_CRON_TOKEN>
DIGEST_SCHEDULER_ENABLED=false
DATABASE_POOL_MAX=10
```

Never copy another installation's production secrets.

## 6. Database

Create your own PostgreSQL database.

Run migrations:

``` bash
corepack pnpm --filter @aidnd/server migrate
```

Create an admin:

``` bash
corepack pnpm --filter @aidnd/server admin:create
```

## 7. Validate

``` bash
corepack pnpm typecheck
corepack pnpm build
corepack pnpm test
```

## 8. Run locally

Backend:

``` bash
corepack pnpm --filter @aidnd/server dev
```

Frontend:

``` bash
corepack pnpm --filter @aidnd/web dev
```

Open:

`http://localhost:5173`

## 9. Add a source

Use:

`Sources -> Add source`

Configure:

-   source name;
-   website URL;
-   RSS URL;
-   enabled.

Start with a known working RSS feed.

## 10. Configure recipient

Use:

`Settings -> Recipient email`

Do not hard-code the recipient.

## 11. Useful server commands

``` bash
corepack pnpm --filter @aidnd/server run
corepack pnpm --filter @aidnd/server migrate
corepack pnpm --filter @aidnd/server admin:create
corepack pnpm --filter @aidnd/server ai:smoke
corepack pnpm --filter @aidnd/server digest:run
```

**Warning:** `digest:run` uses the database from `.env`. Be certain
which database you are targeting before running it.

## 12. Production deployment

The normal flow is:

``` text
git push origin main
  -> Render
  -> Docker build
  -> Production deployment
```

Before pushing:

``` bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
git diff --check
```

## 13. Production checks

After deployment:

``` text
https://your-domain/health
https://your-domain/ready
```

Expected:

``` json
{"status":"ok"}
```

and:

``` json
{"status":"ready"}
```

## 14. Git safety

Never commit:

``` text
.env
API keys
passwords
DATABASE_URL
SESSION_SECRET
CRON_TRIGGER_TOKEN
cookie files
temporary headers
```

Check:

``` bash
git status --short --ignored
```

The real `.env` should be ignored.

## 15. Golden rule

If a command could modify production data, read its
implementation/documentation first. Never guess production commands or
manually edit production rows.
