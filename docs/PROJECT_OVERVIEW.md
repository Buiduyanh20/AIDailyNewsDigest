# AI Daily News Digest --- Project Overview

## Product

AI Daily News Digest is a personal AI-powered news aggregation system
consisting of a responsive Web App and a Daily Email Digest.

Core flow:

``` text
RSS Sources
  -> Articles
  -> pg-boss / Workers
  -> Gemini AI
  -> Events
  -> Daily Digest
  -> Resend
  -> User Email
```

## Technology

  Area              Technology
  ----------------- -------------------------
  Language          TypeScript
  Runtime           Node.js 22
  Frontend          React
  Build             Vite 8.0.5
  Backend           Fastify
  Database          PostgreSQL
  Production DB     Neon PostgreSQL
  Queue             pg-boss
  AI                Google Gemini
  Gemini model      `gemini-3.5-flash-lite`
  Email             Resend
  Hosting           Render Free
  Scheduler         cron-job.org
  Container         Docker
  Package manager   pnpm

## Repository

`https://github.com/Buiduyanh20/AIDailyNewsDigest`

Main directories:

``` text
apps/server/       Backend, workers, migrations, AI, digest, email, RSS
apps/web/          React frontend
packages/domain/   Shared business/domain rules
packages/contracts/ Shared API/data contracts
docs/              Product, technical and deployment docs
.github/workflows/ GitHub Actions
Dockerfile         Production image
docker-compose.yml Local infrastructure
.env.example       Environment template
```

## AI rules

The AI system is conservative:

-   uncertain clustering does not merge;
-   evidence IDs must be valid;
-   summaries must be grounded in supplied Articles;
-   causal claims are restricted;
-   filler phrases are rejected;
-   Vietnamese titles and summaries are generated from source content;
-   Vietnamese, English and Japanese Articles can be compared.

## Digest

Business timezone:

`Asia/Tokyo`

Target timeline:

``` text
06:00 JST  Generate
06:45 JST  Freeze
07:00 JST  Deliver
```

Production uses an external scheduler because Render Free can sleep.

## Production architecture

``` text
cron-job.org
    -> HTTPS trigger
Render Free / Docker
    -> Fastify + pg-boss + workers
    -> Neon PostgreSQL
    -> Gemini
    -> Resend
```

Production keeps:

``` env
DIGEST_SCHEDULER_ENABLED=false
```

The application itself decides what work is due from the JST clock.

## Important rule

Do not manually edit or delete frozen Digest records. The Digest system
intentionally uses snapshot immutability and idempotency.
