# AI Daily News Digest --- Production Operations Runbook

## Production

URL:

`https://digest.buiduyanh.io.vn`

Health:

`https://digest.buiduyanh.io.vn/health`

Readiness:

`https://digest.buiduyanh.io.vn/ready`

## Architecture

``` text
cron-job.org
  -> POST + Bearer token
  -> Render Free
  -> Fastify / pg-boss
  -> Neon
  -> Gemini / Resend
```

## Cron endpoint

``` http
POST /api/v1/internal/cron/daily-digest
Authorization: Bearer <CRON_TRIGGER_TOKEN>
```

Expected:

`202 Accepted`

Never put the token in the URL.

## Schedule

Timezone:

`Asia/Tokyo`

Crontab:

``` text
*/10 5-7 * * *
```

The application decides the actual operation from the JST clock.

## Morning business timeline

``` text
05:00–05:29  Wake/trigger
05:30–05:59  RSS collection
06:00–06:44  Digest generation
06:45         Snapshot cutoff/freeze
07:00+        Delivery
```

## Monitor

### Render

Check:

-   deployment status;
-   application logs;
-   `/health`;
-   `/ready`;
-   crashes;
-   configuration warnings.

### Neon

Check:

-   database availability;
-   connection errors;
-   migrations;
-   storage.

### cron-job.org

Check:

-   execution history;
-   HTTP status;
-   failed requests.

### Gemini

Check:

-   API key;
-   model availability;
-   429/rate limits;
-   AI failure records.

### Resend

Check:

-   API key;
-   sender domain;
-   accepted deliveries.

## Common HTTP results

`202` = request accepted and work queued.

`401` = missing/incorrect Authorization token.

`404` = verify POST method, exact URL and cron authentication.

`500` = inspect Render application logs.

## RSS troubleshooting

If a source becomes `Error`:

1.  verify the RSS URL directly;
2.  verify it returns XML/RSS;
3.  inspect Render logs;
4.  check timeout/network errors;
5.  check SSRF validation;
6.  retry only after understanding the failure.

## AI troubleshooting

If Articles remain `pending` or `failed`, inspect:

-   Gemini configuration;
-   model;
-   rate limits;
-   processing attempts;
-   worker logs.

Do not manually change processing state unless a supported operation
exists.

## Digest troubleshooting

Frozen Digests are intentionally immutable.

Do not manually delete or edit Digest rows to force regeneration.

`digest:run` is a real database operation. Always verify `.env` points
to the intended database before using it.

## Emergency stop

If unexpected emails are being sent:

1.  Disable the cron-job.org job.
2.  Inspect Render logs.
3.  Do not delete production records.
4.  Identify the Digest/delivery state.
5.  Fix the cause.
6.  Re-enable automation only after verification.

## Backup

Backup workflow:

``` text
.github/workflows/db-backup.yml
```

Production backups should be encrypted and retained according to the
configured policy.

Restore tests must use a temporary database, never the live database.

## Deployment

``` bash
corepack pnpm test
corepack pnpm build
corepack pnpm typecheck
git diff --check

git add .
git commit -m "..."
git push origin main
```

Then verify:

``` text
/health -> 200
/ready  -> 200
```

## Render Free limitation

Render Free can spin down after inactivity. External cron is therefore
part of the production design.

The application keeps:

``` env
DIGEST_SCHEDULER_ENABLED=false
```

## Operational principle

Prefer simple, idempotent, observable and recoverable operations over
manual database changes.
