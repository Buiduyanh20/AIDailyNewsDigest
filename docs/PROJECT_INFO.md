# AI Daily News Digest --- Project Information

## Identity

**Repository**

`https://github.com/Buiduyanh20/AIDailyNewsDigest`

**Production URL**

`https://digest.buiduyanh.io.vn`

**Health**

`https://digest.buiduyanh.io.vn/health`

**Readiness**

`https://digest.buiduyanh.io.vn/ready`

**Cron endpoint**

`POST https://digest.buiduyanh.io.vn/api/v1/internal/cron/daily-digest`

## Production providers

  Service         Purpose
  --------------- -------------------------------
  GitHub          Source repository
  Render Free     Web/API/worker Docker service
  Neon            PostgreSQL
  Google Gemini   AI clustering and summaries
  Resend          Transactional email
  cron-job.org    External scheduler

## Email

Sender:

`news@buiduyanh.io.vn`

Current recipient:

`buiduyanh.it@gmail.com`

The recipient is application data and should normally be changed through
the Settings page.

## Production domain

`digest.buiduyanh.io.vn`

DNS:

``` text
digest CNAME aidailynewsdigest.onrender.com
```

HTTPS is managed by Render.

Do not change existing Resend DNS records unless required.

## Database

Production uses Neon PostgreSQL on the `production` branch.

The real `DATABASE_URL` is a secret and is intentionally not documented
here.

## AI

Current model:

`gemini-3.5-flash-lite`

The real Gemini API key is intentionally not documented here.

## Cron

Timezone:

`Asia/Tokyo`

Schedule:

``` text
*/10 5-7 * * *
```

The request must be:

``` http
POST /api/v1/internal/cron/daily-digest
Authorization: Bearer <CRON_TRIGGER_TOKEN>
```

The token is intentionally not documented here.

## Production environment

``` text
NODE_ENV=production
DIGEST_SCHEDULER_ENABLED=false
```

Render provides the production PORT.

## Verified areas

``` text
Render deployment       PASS
Docker                  PASS
Neon                    PASS
Migrations              PASS
Custom domain           PASS
HTTPS                   PASS
Health                  PASS
Readiness               PASS
Login                   PASS
RSS collection          PASS
Gemini                  PASS
Events                  PASS
Resend                  PASS
Cron endpoint           PASS
Cron authentication     PASS
Cron-job.org trigger    PASS
```
