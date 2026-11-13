# AI Daily News Digest --- Secrets & Environment

This document contains no real credentials.

## 1. Where configuration lives

### Local development

``` text
.env
```

### Production application

``` text
Render -> Environment
```

### Backup workflow

``` text
GitHub -> Repository Settings -> Actions Secrets
```

## 2. Local `.env`

Create from:

``` powershell
Copy-Item .env.example .env
```

Then:

``` powershell
code .env
```

## 3. Required variables

``` env
NODE_ENV=development
PORT=3000
DATABASE_URL=<DATABASE_URL>
SESSION_SECRET=<LOCAL_SECRET>
CORS_ORIGIN=http://localhost:5173

GEMINI_API_KEY=<GEMINI_API_KEY>
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_TIMEOUT_MS=30000

AI_CANDIDATE_WINDOW_HOURS=72
AI_MAX_CANDIDATES=8

EMAIL_PROVIDER=resend
RESEND_API_KEY=<RESEND_API_KEY>
EMAIL_FROM=<VERIFIED_SENDER>
EMAIL_TIMEOUT_MS=15000

CRON_TRIGGER_TOKEN=<CRON_TOKEN>
DIGEST_SCHEDULER_ENABLED=false
DATABASE_POOL_MAX=10
```

## 4. Production variables

``` env
NODE_ENV=production
DATABASE_URL=<NEON_PRODUCTION_URL>
SESSION_SECRET=<PRODUCTION_SECRET>
CORS_ORIGIN=https://your-domain.com

GEMINI_API_KEY=<GEMINI_API_KEY>
GEMINI_MODEL=gemini-3.5-flash-lite
GEMINI_TIMEOUT_MS=30000

AI_CANDIDATE_WINDOW_HOURS=72
AI_MAX_CANDIDATES=8

EMAIL_PROVIDER=resend
RESEND_API_KEY=<RESEND_API_KEY>
EMAIL_FROM=<VERIFIED_SENDER>
EMAIL_TIMEOUT_MS=15000

CRON_TRIGGER_TOKEN=<CRON_TOKEN>
DIGEST_SCHEDULER_ENABLED=false
DATABASE_POOL_MAX=10
```

Render provides `PORT` in production; do not hard-code it.

## 5. Secrets

Never commit:

``` text
DATABASE_URL
SESSION_SECRET
GEMINI_API_KEY
RESEND_API_KEY
CRON_TRIGGER_TOKEN
ADMIN_PASSWORD
BACKUP_PASSPHRASE
NEON_BACKUP_DATABASE_URL
```

## 6. Safe documentation

It is okay to document:

``` text
GEMINI_MODEL=gemini-3.5-flash-lite
EMAIL_PROVIDER=resend
EMAIL_FROM=your-verified-sender
DIGEST_SCHEDULER_ENABLED=false
```

Do not document real secret values.

## 7. Two-machine workflow

Each computer can have its own ignored:

``` text
.env
```

Production secrets stay in Render.

For shared personal credentials, use a password manager rather than Git.

## 8. If `.env` is lost

``` powershell
Copy-Item .env.example .env
```

Then restore values from the password manager/provider dashboards.

Do not try to recover secrets from Git history.

## 9. Git verification

``` bash
git status --short --ignored
```

The real `.env` should appear as ignored, for example:

``` text
!! .env
```

## 10. Secret rotation

If a secret is exposed:

1.  revoke/rotate it at the provider;
2.  update the correct environment;
3.  redeploy if required;
4.  inspect Git history and logs;
5.  do not assume deleting the visible text makes the old secret safe.

## 11. Provider setup

### Gemini

Create a personal API key and set:

``` env
GEMINI_API_KEY=<YOUR_KEY>
```

### Resend

Create a personal API key, verify a sending domain, then set:

``` env
RESEND_API_KEY=<YOUR_KEY>
EMAIL_FROM=<VERIFIED_SENDER>
```

### Neon

Create your own PostgreSQL project and set:

``` env
DATABASE_URL=<YOUR_CONNECTION_STRING>
```

### Cron

Generate a new random value and use the same value in:

``` text
Render: CRON_TRIGGER_TOKEN
cron-job.org: Authorization: Bearer <TOKEN>
```

Do not use the original installation's token.

## 12. Golden rule

If a value could grant access to a database, API, email provider, admin
account or production service, treat it as a secret and keep it out of
Git.
