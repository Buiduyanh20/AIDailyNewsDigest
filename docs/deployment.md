# Production deployment — Render + Neon + Cron-job.org

Production URL: **https://digest.buiduyanh.io.vn**

```text
GitHub (main) ──auto-deploy──▶ Render Web Service (Docker, Free)
                                 └─ one container: Fastify API + pg-boss workers + React app
                                        │
                                        ▼
                                 Neon PostgreSQL ── Gemini API ── Resend
Cron-job.org ──POST + Bearer token──▶ /api/v1/internal/cron/daily-digest
GitHub Actions (daily) ──pg_dump, encrypted──▶ 14-day backup artifacts
```

No real credentials belong in this file, in Git, or in the Docker image. Secrets live only in
Render's environment, Cron-job.org's job header, GitHub Actions secrets, and your password manager.

---

## 1. Why Cron-job.org calls the app every 10 minutes (Free-tier design)

A Render Free web service **spins down after ~15 minutes without inbound HTTP traffic**. Background
work (pg-boss jobs, the outbox dispatcher) does not keep it awake, and in-process timers do not fire
while it sleeps. A single call at 06:00 JST would therefore leave the service asleep at the 06:45
cutoff and the 07:00 send.

So Cron-job.org calls one idempotent endpoint **every 10 minutes from 05:00 to 07:50 JST**. Each call
wakes the service (or keeps it awake). The server then works out from the JST clock what is due and
enqueues it on the existing pg-boss queues, using the same workers and business logic as before:

| JST time of the call | What the server enqueues |
|---|---|
| before 05:30 | nothing (the call only wakes the service; a cold start can take up to a minute) |
| 05:30 – 06:44 | RSS collection for all enabled Sources (**at most once per JST morning**) |
| 06:00 – 06:44 | Digest **draft** for yesterday's JST date (06:00 generate, 06:30 candidate snapshot) |
| 06:45 and later | Digest **finalize** (immutable snapshot at the 06:45 cutoff) |
| 07:00 and later | finalize also hands a frozen, unsent Digest to delivery; the 07:00 `digest.ready` outbox row sends it |

The business rules stay in the app: Digest = previous JST calendar day, cutoff 06:45, send 07:00,
Asia/Tokyo. Cron-job.org only wakes the app. Repeated or retried calls are coalesced (pg-boss throttling).
The Digest and EmailDelivery unique constraints, plus the atomic delivery claim, still guarantee at
most **one Digest and one email per JST date**.

In production the in-process pg-boss cron is switched off (`DIGEST_SCHEDULER_ENABLED=false`), so
Cron-job.org is the only scheduler. That also means waking the app at other times (for example
opening the dashboard) never triggers a Digest. Locally, the in-process scheduler still works as before.

---

## 2. Environment variables (audited against `apps/server/src/config/env.ts`)

### Render → Environment

| Variable | Required | Example / format | Notes |
|---|---|---|---|
| `NODE_ENV` | Yes (preset in image) | `production` | The Dockerfile already sets it; setting it in Render too is harmless. |
| `PORT` | Yes (Render-provided) | `10000` | **Do not set.** Render injects it; the server listens on `0.0.0.0:$PORT`. Startup fails in production without it. |
| `DATABASE_URL` | Yes | `postgresql://USER:PASSWORD@ep-xxx.ap-southeast-1.aws.neon.tech/neondb?sslmode=require` | Neon **direct** (non-pooler) connection string; keep `sslmode=require`. |
| `SESSION_SECRET` | Yes | 64+ random characters | `openssl rand -base64 48`. Never reuse it for anything else. |
| `CORS_ORIGIN` | Yes | `https://digest.buiduyanh.io.vn` | Must be one exact `https://` origin; `*` and `http://` are rejected at startup. |
| `GEMINI_API_KEY` | Yes | secret | Server-side only. |
| `GEMINI_MODEL` | Yes (has a default) | `gemini-3.5-flash-lite` | Set it explicitly; do not change it during deployment. |
| `EMAIL_PROVIDER` | Yes | `resend` | The only supported value. |
| `RESEND_API_KEY` | Yes | secret | A send-only (restricted) key is enough. |
| `EMAIL_FROM` | Yes | `news@buiduyanh.io.vn` | Verified Resend sender. |
| `CRON_TRIGGER_TOKEN` | Yes (to enable the cron endpoint) | 64 hex characters | `openssl rand -hex 32`. Must be at least 32 characters. Unset means the endpoint returns 404. Must differ from every other secret. |
| `DIGEST_SCHEDULER_ENABLED` | Yes in production | `false` | Makes Cron-job.org the single scheduler (see §1). |
| `GEMINI_TIMEOUT_MS` | Optional | `30000` | Default 30000. |
| `AI_CANDIDATE_WINDOW_HOURS` | Optional | `72` | Default 72. |
| `AI_MAX_CANDIDATES` | Optional | `8` | Default 8. |
| `EMAIL_TIMEOUT_MS` | Optional | `15000` | Default 15000. |
| `RESEND_WEBHOOK_SECRET` | Optional | `whsec_…` | Only if you add a Resend webhook to `https://digest.buiduyanh.io.vn/api/v1/webhooks/resend` (records delivered/bounced status). |
| `DATABASE_POOL_MAX` | Optional | `10` | App pool size (pg-boss keeps its own pool of up to 10). |
| `WEB_DIST_DIR` | Optional | — | Leave unset; the image serves `apps/web/dist` automatically. |

### Provisioning only — set in your local shell for one command, never on Render

| Variable | Used by |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | `admin:create` (one-time admin provisioning). The running server does not use them. |

### Development / test only

`TEST_DATABASE_URL` (integration tests) and `EVAL_DATABASE_URL` (manual `ai:eval`).

### Deprecated / not used

- `EMAIL_API_KEY`: old alias for `RESEND_API_KEY`, still accepted. Use `RESEND_API_KEY`.
- `EMAIL_TO`: **does not exist.** The recipient is application data (`user_settings.recipient_email`), set on the Settings page.

---

## 3. Neon setup

1. Create a Neon project (Free plan). Region: **AWS Asia Pacific (Singapore)**, close to Render's
   Singapore region. Postgres version: **17** (the backup workflow defaults to `PG_MAJOR=17`; if you
   choose another version, set the GitHub variable `PG_MAJOR` to match).
2. Under **Connect**, copy the connection string with **Connection pooling turned off** (the direct
   host, without `-pooler`). It already contains `sslmode=require`. pg-boss, the migration lock and the
   transactional outbox expect a normal session connection; the app opens about 20 connections at most.
3. Keep TLS on. Never add `sslmode=disable` or `rejectUnauthorized=false`; Neon's certificate is
   verified against the public CA store.
4. Optional, for backups: create a read-only role and a connection string for it
   (`NEON_BACKUP_DATABASE_URL`, see §8).

Use a **fresh** database. Do not copy development or test data into production.

### Run migrations against Neon (from your machine)

Render Free has no shell and no pre-deploy command, so migrations run from a local checkout. They
are forward-only, run in a single transaction under an advisory lock, are recorded in
`schema_migrations`, and are safe to re-run. Nothing drops or truncates data.

```powershell
# PowerShell, in the repository root (values come from your password manager; nothing is written to disk)
$env:DATABASE_URL = "<Neon direct connection string>"
$env:SESSION_SECRET = "<any value; required by the config loader>"
corepack pnpm install
corepack pnpm --filter @aidnd/server migrate
Remove-Item Env:DATABASE_URL, Env:SESSION_SECRET
```

Run this **before** each deploy that adds a migration file (`apps/server/migrations/NNN_*.sql`).
`/ready` returns 503 until the required migration is present.

### Provision the admin (once)

```powershell
$env:DATABASE_URL = "<Neon direct connection string>"
$env:SESSION_SECRET = "<any value>"
$env:ADMIN_EMAIL = "<production admin email>"
corepack pnpm --filter @aidnd/server admin:create   # prompts for the password if ADMIN_PASSWORD is unset
Remove-Item Env:DATABASE_URL, Env:SESSION_SECRET, Env:ADMIN_EMAIL
```

There is no public registration. The command prints only the email address, never the password.
It sets the recipient to the admin email at first, so change it on the Settings page (step 5 of §6)
**before** any Digest trigger.

---

## 4. Render setup (Web Service, Docker)

1. **New → Web Service** → connect GitHub → choose the repository → branch **`main`**.
2. Settings:
   - **Language/Runtime:** Docker
   - **Root Directory:** empty (repository root)
   - **Dockerfile Path:** `./Dockerfile`
   - **Docker Build Context Directory:** `.`
   - **Docker Command:** empty (the image runs `node apps/server/dist/main.js`)
   - **Region:** Singapore
   - **Instance Type:** Free
3. **Environment**: add the variables from §2 (do not add `PORT`).
4. **Advanced → Health Check Path:** `/health`.
5. **Auto-Deploy:** On Commit.
6. **Create Web Service** and wait for "Live". Check:
   - `https://<service>.onrender.com/health` → `{"status":"ok"}`
   - `https://<service>.onrender.com/ready` → `{"status":"ready"}` (database, pg-boss, migrations)

On a redeploy, Render sends SIGTERM. The server stops accepting requests, finishes in-flight requests
and jobs (up to 20 s), closes pg-boss and the pool, and exits before Render's 30 s grace period.
Unfinished jobs stay in pg-boss and are retried.

### Custom domain and HTTPS

1. Render service → **Settings → Custom Domains → Add** `digest.buiduyanh.io.vn`.
2. At the DNS provider of `buiduyanh.io.vn`, add the record Render shows. For a subdomain this is:
   `CNAME  digest  →  <service>.onrender.com`. Leave the existing Resend records (SPF/DKIM/MX for
   `news@`) untouched.
3. Wait until Render shows the domain as verified and the certificate as issued. Render terminates
   HTTPS and redirects HTTP to HTTPS. The session and CSRF cookies are `Secure`, so login only works
   over HTTPS.

---

## 5. Cron-job.org setup (enable only after §6 passes)

Create **one** cron job:

| Field | Value |
|---|---|
| URL | `https://digest.buiduyanh.io.vn/api/v1/internal/cron/daily-digest` |
| Request method | `POST` |
| Headers (Advanced) | `Authorization: Bearer <CRON_TRIGGER_TOKEN>` |
| Request body | empty |
| Schedule | Custom: minutes `0,10,20,30,40,50`, hours `5,6,7`, every day |
| Time zone | `Asia/Tokyo` |
| Notifications | on failure (optional) |

- If the job editor or your account can only schedule in **UTC**, use hours `20,21,22` with the
  same minutes. JST is UTC+9 and **Asia/Tokyo has no daylight saving time**, so the conversion never
  changes: 05:00–07:50 JST = 20:00–22:50 UTC on the previous day.
- Never put the token in the URL. The server only accepts it in the `Authorization` header and does
  not log headers.
- The first call of the morning may time out while Render cold-starts the container. That is
  expected and harmless: the call still wakes the service, and the 05:10 call goes through. Expected
  responses: `202 {"status":"accepted","localDate":"YYYY-MM-DD","jobs":[...]}`. `jobId: null` means a
  retried call was coalesced.
- A 401 means the token is wrong; a 404 means `CRON_TRIGGER_TOKEN` is not set on Render.

---

## 6. First production run (one controlled email, then automation)

Keep `DIGEST_SCHEDULER_ENABLED=false` and leave the Cron-job.org job **disabled** until every step passes.

1. `https://digest.buiduyanh.io.vn/health` → 200; `/ready` → 200.
2. Log in with the admin account (HTTPS). Check that logout works too.
3. **Sources:** add only verified feeds:
   - VnExpress `https://vnexpress.net/rss/the-gioi.rss`
   - VTV `https://vtv.vn/rss/the-gioi.rss`
   - BBC News `https://feeds.bbci.co.uk/news/world/rss.xml`
   - Yahoo!ニュース `https://news.yahoo.co.jp/rss/topics/world.xml`
4. Day D, during the day: click **Retry** (collect) on each Source and keep the dashboard open while
   articles are processed. The free Gemini tier allows about 7 articles a minute; the service sleeps
   after 15 idle minutes, so refresh occasionally. Check that Events with Vietnamese summaries appear
   (this proves Gemini works).
5. **Settings:** set the recipient to `buiduyanh.it@gmail.com` and save (stored in
   `user_settings.recipient_email`).
6. Day D+1, **after 07:00 JST**, send one manual trigger:
   ```bash
   curl -i -X POST -H "Authorization: Bearer $CRON_TRIGGER_TOKEN" \
     https://digest.buiduyanh.io.vn/api/v1/internal/cron/daily-digest
   ```
   It finalizes Day D's Digest (immutable snapshot) and sends it once. Calling it again does not send
   a second email.
7. Check the dashboard: Digest D shows `Sent` / `Accepted by provider`, and the email preview matches.
   Check that **Gmail received "Tin nhanh ngày DD"** (look in spam too).
8. Now enable the Cron-job.org job (§5). From the next morning it collects at 05:30, drafts at 06:00,
   freezes at 06:45 and sends at 07:00 JST.

Do not send further test emails. Failure scenarios are covered by the automated tests
(FakeEmailProvider / FakeAIProvider).

---

## 7. Monitoring (lightweight)

- `GET /health` (liveness, used by Render) and `GET /ready` (database + pg-boss + migrations; 503 when not ready).
- Render → Logs: structured JSON lines (`cron tick accepted`, `digest generation fan-out queued`,
  `process-article completed/failed`, `request failed`). Logs contain IDs, statuses and error codes only;
  never keys, tokens, cookies, Authorization headers or passwords.
- Dashboard: Digest status, email delivery status, Source status (Active/Error).
- Cron-job.org execution history (HTTP status of each call).

---

## 8. Backup and restore

### What Neon Free provides

Neon's point-in-time restore is limited by the plan's **history (restore) window**. On the Free plan
this window is much shorter than the 7–14 day target. Check the current value under Neon →
**Settings → Storage** / the Neon pricing page; it is not assumed here. The MVP target is therefore
met with a **daily logical backup**:

- `.github/workflows/db-backup.yml` runs **daily at 03:00 JST** (18:00 UTC) and on demand
  (**Actions → db-backup → Run workflow**).
- `pg_dump --format=custom` → checked with `pg_restore --list` → encrypted with **AES-256 (gpg,
  symmetric)** → stored as a workflow artifact with **14-day retention**. The plaintext dump is never
  uploaded.
- Repository secrets: `NEON_BACKUP_DATABASE_URL` (read-only role recommended) and `BACKUP_PASSPHRASE`.
  Keep a copy of the passphrase in your password manager: without it the backups cannot be restored.
- Optional repository variable: `PG_MAJOR` (default `17`), the Neon Postgres major version.

The workflow runs once the repository is on GitHub with Actions enabled. Trigger it once by hand and
check that an `aidnd-db-…` artifact appears.

### Restore procedure (into a temporary database first)

Never restore over the live production database to test.

```bash
# 1. Download the artifact (Actions → db-backup run → Artifacts) and unzip it.
sha256sum -c aidnd-YYYYMMDD-HHMM.dump.gpg.sha256
gpg --decrypt --output aidnd.dump aidnd-YYYYMMDD-HHMM.dump.gpg        # asks for BACKUP_PASSPHRASE

# 2. Restore into an EMPTY temporary database (a local Docker Postgres or a Neon branch/database):
pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --no-acl --exit-on-error aidnd.dump

# 3. Verify (expected: the same row counts as production at backup time)
psql "$RESTORE_DATABASE_URL" -c "select version from schema_migrations order by 1" \
  -c "select (select count(*) from users) users, (select count(*) from sources) sources,
             (select count(*) from articles) articles, (select count(*) from events) events,
             (select count(*) from daily_digests) digests, (select count(*) from email_deliveries) emails"
```

For a real disaster recovery, restore into a new Neon database, point `DATABASE_URL` on Render at it,
redeploy, and check `/ready`. Running `migrate` afterwards is a no-op if the backup was current.

**Restore test performed (Phase 9, local):** a real-data database (1 user, 4 Sources, 155 Articles,
122 Events, 1 sent Digest with 22 snapshots, 1 email record, 604 processing attempts) was dumped
with the workflow's exact flags, encrypted and decrypted with gpg (byte-identical; a wrong passphrase
was rejected), and restored into a temporary database. Row counts were identical for all 11 tables,
content hashes matched for users, settings, Sources, Articles, Events, Digests, snapshots and email
history, and all 4 migrations and the 3 immutability triggers were present (a snapshot edit was still
rejected). Repeat this test once against a real artifact after the first scheduled backup.

---

## 9. Security checklist

- Secrets only in Render env, Cron-job.org header, GitHub Actions secrets and your password manager.
  `.env` is git-ignored and excluded from the Docker build context (`.dockerignore` allowlist).
- The image runs as the non-root `node` user and contains only compiled output, migrations,
  production dependencies and the web build. No `.env`, `.git`, sources, test files or build tools.
- The web bundle contains no API keys, database URL, session secret or cron token (all are server-side).
- CORS: one exact HTTPS origin; no wildcard.
- Cookies: session `HttpOnly; Secure; SameSite=Lax`; CSRF double-submit on every mutation.
- Admin APIs require a session; the cron endpoint requires the Bearer token (constant-time compare)
  and is disabled without one; the Resend webhook requires a valid Svix signature.
- Rotate `CRON_TRIGGER_TOKEN` by changing it in Render and in Cron-job.org together.
