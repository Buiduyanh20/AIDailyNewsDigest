import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { config } from "dotenv";
import { Pool } from "pg";

import { EMPTY_DIGEST_MESSAGE, digestTimeline, type Source } from "@aidnd/domain";

import { buildApp } from "../app.js";
import { AuthService } from "../auth/service.js";
import { createAuthStore } from "../db/auth-store.js";
import { runMigrations } from "../db/migrate.js";
import { createPostgresRepositories, type PostgresRepositories } from "../db/repositories.js";
import { FakeEmailProvider } from "../email/fake-provider.js";
import { EmailProviderError, type EmailProvider, type SendEmailInput } from "../email/provider.js";
import { silentProcessingLogger } from "../events/processor.js";
import { OutboxDispatcher } from "../outbox/dispatcher.js";
import { PostgresJobQueue } from "../queue/job-queue.js";
import { SettingsService } from "../settings/service.js";
import { enqueueDigestDelivery, fanOutGeneration, registerDigestJobs, runCronTick, startDigestScheduler, type DigestJobDeps } from "./jobs.js";
import { DefaultDigestApi, DigestDeliveryService, DigestGenerationService, type DeliveryPolicy } from "./service.js";
import { DIGEST_DELIVER_EVENT, DIGEST_READY_EVENT, PostgresDigestStore } from "./store.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), override: false });
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

const D = "2026-11-12";
const FROM = "news@example.test";
const RECIPIENT_A = "reader-a@example.com";
const RECIPIENT_B = "reader-b@example.com";
const POLICY: DeliveryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 5_000, random: () => 0.5 };
const { cutoffAt } = digestTimeline(D);

async function withIsolatedSchema<T>(work: (pool: Pool, schema: string) => Promise<T>): Promise<T> {
  const schema = `phase6_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  let pool: Pool | undefined;
  let created = false;
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await runMigrations(pool);
    return await work(pool, schema);
  } finally {
    await pool?.end();
    if (created) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

type Harness = {
  pool: Pool;
  repositories: PostgresRepositories;
  userId: string;
  sources: Record<"vtv" | "vnexpress" | "nhk", Source>;
  store: PostgresDigestStore;
  generation: DigestGenerationService;
  /** Creates a processed Event with processed Articles (each Article's publish time in UTC ISO). */
  addEvent(input: { title: string; articles: Array<{ source: Source; title: string; publishedAt: string; discoveredAt?: string; processed?: boolean }> }): Promise<string>;
  delivery(email: EmailProvider): DigestDeliveryService;
};

const jstDate = (iso: string) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(iso));

async function createHarness(pool: Pool, existingUserId?: string): Promise<Harness> {
  const repositories = createPostgresRepositories(pool);
  const userId =
    existingUserId ?? (await repositories.users.create({ email: `phase6-${randomBytes(5).toString("hex")}@example.com`, passwordHash: "x" })).id;
  if (!existingUserId) {
    await repositories.userSettings.upsert({ userId, recipientEmail: RECIPIENT_A, timezone: "Asia/Tokyo", sendLocalTime: "07:00" });
  }
  const source = (name: string, host: string) => repositories.sources.create({ userId, name, websiteUrl: `https://${host}` });
  const sources = { vtv: await source("VTV", "vtv.vn"), vnexpress: await source("VnExpress", "vnexpress.net"), nhk: await source("NHK", "www3.nhk.or.jp") };
  const store = new PostgresDigestStore(pool);
  return {
    pool,
    repositories,
    userId,
    sources,
    store,
    generation: new DigestGenerationService(store, silentProcessingLogger),
    async addEvent(input) {
      const times = input.articles.map((article) => article.publishedAt).sort();
      const event = await repositories.events.create({
        userId,
        titleVi: input.title,
        summaryVi: `${input.title} đã được nhiều nguồn đưa tin. Đây là bản tóm tắt thử nghiệm.`,
        status: "active",
        processingStatus: "processed",
        firstSeenAt: times[0]!,
        lastSeenAt: times.at(-1)!,
      });
      for (const article of input.articles) {
        const url = `${article.source.websiteUrl}/news/${randomBytes(4).toString("hex")}`;
        const created = await repositories.articles.create({
          sourceId: article.source.id,
          originalUrl: url,
          canonicalUrl: url,
          originalTitle: article.title,
          publishedAt: article.publishedAt,
          publishedDateJst: jstDate(article.publishedAt),
          discoveredAt: article.discoveredAt ?? new Date(new Date(article.publishedAt).getTime() + 10 * 60_000).toISOString(),
          processingStatus: article.processed === false ? "failed" : "processed",
        });
        if (article.processed !== false) {
          await repositories.eventArticles.create({ eventId: event.id, articleId: created.id, associationMethod: "ai_new_event" });
        }
      }
      return event.id;
    },
    delivery(email) {
      return new DigestDeliveryService({ store, email, from: FROM, logger: silentProcessingLogger, policy: POLICY });
    },
  };
}

const count = async (pool: Pool, sql: string, values: unknown[] = []) => Number((await pool.query<{ n: string }>(sql, values)).rows[0]!.n);
// UTC instants for JST wall-clock times on 12/11 and 13/11.
const jst = (day: 12 | 13, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour - 9, minute)).toISOString();

test(
  "Phase 6 Daily Digest + email delivery with PostgreSQL and FakeEmailProvider",
  { skip: databaseUrl ? false : "Set TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests." },
  async (t) => {
    await t.test("Test 1 — 5 Events → 1 Digest, 5 snapshots (JST date, latest-first order) → 1 email", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const ids = [];
        for (let index = 0; index < 5; index += 1) {
          ids.push(await h.addEvent({ title: `Sự kiện số ${index + 1}`, articles: [{ source: h.sources.vtv, title: `Bài ${index + 1}`, publishedAt: jst(12, 8 + index) }] }));
        }
        // Multi-source Event; its latest Article is 23:59 JST on the 12th (still date D).
        const storm = await h.addEvent({
          title: "Bão X đổ bộ miền Trung",
          articles: [
            { source: h.sources.vnexpress, title: "Bão X đổ bộ", publishedAt: jst(12, 7) },
            { source: h.sources.vtv, title: "Bão X gây mưa lớn", publishedAt: jst(12, 9) },
            { source: h.sources.nhk, title: "台風Xが上陸", publishedAt: jst(12, 23, 59) },
          ],
        });
        // 00:00 JST on the 13th belongs to the next Digest.
        await h.addEvent({ title: "Tin ngày 13", articles: [{ source: h.sources.vtv, title: "Ngày 13", publishedAt: jst(13, 0, 0) }] });

        const built = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        assert.equal(built.digest.status, "ready");
        assert.equal(built.digest.localDate, D, "DATE preserved exactly");
        assert.equal(built.eventCount, 6);
        const snapshot = await h.store.getSnapshotEvents(built.digest.id);
        assert.deepEqual(snapshot.map((event) => event.eventId), [storm, ...ids.reverse()], "latest relevant Article first");
        assert.deepEqual(snapshot[0]!.sources.sort(), ["NHK", "VTV", "VnExpress"]);
        assert.ok(!snapshot.some((event) => event.titleVi === "Tin ngày 13"));

        const email = new FakeEmailProvider();
        const outcome = await h.delivery(email).deliver(built.digest.id);
        assert.equal(outcome.status, "sent");
        assert.equal(email.sent.length, 1);
        const sent = email.sent[0]!;
        assert.deepEqual([sent.from, sent.to, sent.subject, sent.idempotencyKey], [FROM, RECIPIENT_A, "Tin nhanh ngày 12", `daily-digest:${h.userId}:${D}`]);
        assert.ok(sent.html.includes("Tin nhanh ngày 12/11/2026") && sent.html.includes("Bão X đổ bộ miền Trung"));
        assert.ok(sent.html.includes("https://vnexpress.net/news/"), "original Article links");
        assert.equal(await count(pool, "SELECT COUNT(*) n FROM daily_digests"), 1);
        assert.equal(await count(pool, "SELECT COUNT(*) n FROM email_deliveries WHERE status = 'accepted'"), 1);
        assert.equal((await h.store.getDigest(built.digest.id))!.status, "sent");
        assert.equal(await count(pool, `SELECT COUNT(*) n FROM outbox_events WHERE event_type = $1`, [DIGEST_READY_EVENT]), 1);
      });
    });

    await t.test("Test 2 — 0 Events → 1 empty Digest → 1 empty email", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const built = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        assert.deepEqual([built.digest.status, built.eventCount], ["ready", 0]);
        const email = new FakeEmailProvider();
        assert.equal((await h.delivery(email).deliver(built.digest.id)).status, "sent");
        assert.equal(email.sent.length, 1);
        assert.ok(email.sent[0]!.html.includes(EMPTY_DIGEST_MESSAGE));
        assert.equal(email.sent[0]!.subject, "Tin nhanh ngày 12");
      });
    });

    await t.test("Test 3 — duplicate generation → 1 Digest; draft rebuilds until the cutoff freezes it", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        await h.addEvent({ title: "Sự kiện A", articles: [{ source: h.sources.vtv, title: "A", publishedAt: jst(12, 9) }] });
        const draft = await h.generation.generate({ userId: h.userId, localDate: D, mode: "draft" });
        assert.deepEqual([draft.digest.status, draft.eventCount], ["building", 1]);
        await h.addEvent({ title: "Sự kiện B", articles: [{ source: h.sources.vtv, title: "B", publishedAt: jst(12, 10) }] });
        const redraft = await h.generation.generate({ userId: h.userId, localDate: D, mode: "draft" });
        assert.equal(redraft.eventCount, 2, "06:30 candidate snapshot picks up newly processed Events");
        const final = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        const again = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        await h.addEvent({ title: "Sự kiện C", articles: [{ source: h.sources.vtv, title: "C", publishedAt: jst(12, 11) }] });
        const afterCutoff = await h.generation.generate({ userId: h.userId, localDate: D, mode: "draft" });
        assert.equal(again.rebuilt, false);
        assert.equal(afterCutoff.eventCount, 2, "frozen snapshot ignores later Events");
        assert.equal(new Set([draft.digest.id, redraft.digest.id, final.digest.id, again.digest.id, afterCutoff.digest.id]).size, 1);
        assert.equal(await count(pool, "SELECT COUNT(*) n FROM daily_digests"), 1);
        assert.equal(await count(pool, `SELECT COUNT(*) n FROM outbox_events WHERE event_type = $1`, [DIGEST_READY_EVENT]), 1);
      });
    });

    await t.test("Test 4 — sent Digest is immutable (code path and database triggers)", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const eventId = await h.addEvent({ title: "Tiêu đề gốc", articles: [{ source: h.sources.vtv, title: "A", publishedAt: jst(12, 9) }] });
        const built = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        await h.delivery(new FakeEmailProvider()).deliver(built.digest.id);
        const api = new DefaultDigestApi(h.store);
        const before = await api.preview(h.userId, built.digest.id);

        await pool.query(`UPDATE events SET title_vi = 'Tiêu đề đã sửa', summary_vi = 'Tóm tắt mới.' WHERE id = $1`, [eventId]);
        await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        const after = await api.preview(h.userId, built.digest.id);
        assert.deepEqual(after, before, "preview/email content unchanged after the Event changed");
        assert.equal((await h.store.getSnapshotEvents(built.digest.id))[0]!.titleVi, "Tiêu đề gốc");

        const rejected = (sql: string) => assert.rejects(pool.query(sql, [built.digest.id]), (error: unknown) => (error as { code?: string }).code === "23514");
        await rejected(`UPDATE digest_events SET title_vi_snapshot = 'x' WHERE digest_id = $1`);
        await rejected(`DELETE FROM digest_events WHERE digest_id = $1`);
        await rejected(`UPDATE email_deliveries SET subject = 'x' WHERE digest_id = $1`);
        await rejected(`UPDATE daily_digests SET status = 'ready' WHERE id = $1`);
        await rejected(`UPDATE daily_digests SET local_date = '2026-11-11' WHERE id = $1`);
      });
    });

    await t.test("Test 5 — Articles discovered after 06:45 JST are excluded; unfinished ones are marked missed_digest_cutoff", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        await h.addEvent({ title: "Đúng hạn", articles: [{ source: h.sources.vtv, title: "On time", publishedAt: jst(12, 9) }] });
        await h.addEvent({
          title: "Đến muộn",
          articles: [{ source: h.sources.vtv, title: "Late", publishedAt: jst(12, 23, 50), discoveredAt: new Date(cutoffAt.getTime() + 15 * 60_000).toISOString() }],
        });
        await h.addEvent({ title: "Chưa xử lý xong", articles: [{ source: h.sources.nhk, title: "Pending", publishedAt: jst(12, 20), processed: false }] });

        const built = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        assert.deepEqual((await h.store.getSnapshotEvents(built.digest.id)).map((event) => event.titleVi), ["Đúng hạn"]);
        assert.equal(await count(pool, `SELECT COUNT(*) n FROM articles WHERE missed_digest_cutoff AND original_title = 'Pending'`), 1);
        assert.equal(await count(pool, `SELECT COUNT(*) n FROM articles WHERE original_title = 'Late'`), 1, "late Article is kept");
        assert.equal(await count(pool, `SELECT COUNT(*) n FROM articles WHERE missed_digest_cutoff AND original_title = 'Late'`), 0);
      });
    });

    await t.test("Test 6 — many Events and repeated/concurrent delivery → exactly one email", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        for (let index = 0; index < 8; index += 1) {
          await h.addEvent({ title: `Tin ${index}`, articles: [{ source: h.sources.vtv, title: `T${index}`, publishedAt: jst(12, 6 + index) }] });
        }
        const built = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        const email = new FakeEmailProvider();
        const delivery = h.delivery(email);
        const outcomes = await Promise.all([delivery.deliver(built.digest.id), delivery.deliver(built.digest.id), delivery.deliver(built.digest.id)]);
        assert.equal(outcomes.filter((outcome) => outcome.status === "sent").length, 1);
        assert.deepEqual(await delivery.deliver(built.digest.id), { status: "skipped", reason: "already_sent" });
        assert.equal(email.attempts.length, 1);
        assert.equal(await count(pool, "SELECT COUNT(*) n FROM email_deliveries"), 1);
      });
    });

    await t.test("Test 7 — recipient change applies to future Digests only", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const settings = new SettingsService(createAuthStore(pool));
        const email = new FakeEmailProvider();
        const first = await h.generation.generate({ userId: h.userId, localDate: "2026-11-11", mode: "finalize" });
        await h.delivery(email).deliver(first.digest.id);

        await assert.rejects(settings.updateRecipient(h.userId, { recipientEmail: "not-an-email" }), (error: unknown) => (error as { code?: string }).code === "VALIDATION_ERROR");
        await assert.rejects(settings.updateRecipient(h.userId, { recipientEmail: "  " }), (error: unknown) => (error as { code?: string }).code === "VALIDATION_ERROR");
        const saved = await settings.updateRecipient(h.userId, { recipientEmail: "  Reader-B@Example.com " });
        assert.equal(saved.recipientEmail, RECIPIENT_B, "trimmed and normalized");

        const second = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        await h.delivery(email).deliver(second.digest.id);
        assert.deepEqual(email.sent.map((sent) => sent.to), [RECIPIENT_A, RECIPIENT_B]);
        assert.equal((await h.store.getDelivery(first.digest.id))!.recipientEmail, RECIPIENT_A, "sent Digest not re-addressed");
        assert.equal(email.attempts.length, 2, "nothing resent");
      });
    });

    await t.test("Test 8 — provider failures: transient retry, ambiguous timeout reconciled, permanent stop", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);

        // Transient 503 then success → retry scheduled through the outbox, then accepted.
        const flaky = new FakeEmailProvider((_input, attempt) => {
          if (attempt === 1) throw new EmailProviderError("EMAIL_PROVIDER_UNAVAILABLE", "down");
        });
        const d1 = (await h.generation.generate({ userId: h.userId, localDate: "2026-11-10", mode: "finalize" })).digest;
        assert.deepEqual(await h.delivery(flaky).deliver(d1.id), { status: "retry_scheduled", errorCode: "EMAIL_PROVIDER_UNAVAILABLE" });
        assert.equal((await h.store.getDelivery(d1.id))!.status, "failed");
        assert.equal(await count(pool, `SELECT COUNT(*) n FROM outbox_events WHERE event_key = $1 AND available_at > now()`, [`${DIGEST_DELIVER_EVENT}:${d1.id}:2`]), 1);
        assert.equal((await h.delivery(flaky).deliver(d1.id)).status, "sent");
        assert.equal((await h.store.getDelivery(d1.id))!.attemptCount, 2);

        // Timeout AFTER the provider accepted: unknown → retry with the same idempotency key → no second email.
        const accepted: SendEmailInput[] = [];
        let calls = 0;
        const ambiguous: EmailProvider = {
          name: "fake-ambiguous",
          async send(input) {
            calls += 1;
            if (!accepted.some((email) => email.idempotencyKey === input.idempotencyKey)) accepted.push(input);
            if (calls === 1) throw new EmailProviderError("EMAIL_TIMEOUT", "timeout");
            return { status: "accepted", providerMessageId: "msg-ambiguous" };
          },
          async getDeliveryStatus() {
            return "not_found";
          },
        };
        const d2 = (await h.generation.generate({ userId: h.userId, localDate: "2026-11-11", mode: "finalize" })).digest;
        assert.deepEqual(await h.delivery(ambiguous).deliver(d2.id), { status: "unknown", errorCode: "EMAIL_TIMEOUT" });
        assert.equal((await h.store.getDelivery(d2.id))!.status, "unknown");
        assert.equal((await h.delivery(ambiguous).deliver(d2.id)).status, "sent");
        assert.equal(accepted.length, 1, "provider holds exactly one email");

        // Unknown with a known message id: reconciled via provider status, no new send.
        const reconciler = new FakeEmailProvider();
        reconciler.statusById.set("msg-known", "delivered");
        const d3 = (await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" })).digest;
        await h.store.ensureDelivery({ digestId: d3.id, idempotencyKey: `daily-digest:${h.userId}:${D}`, provider: "fake-email", recipientEmail: RECIPIENT_A, senderEmail: FROM, subject: "Tin nhanh ngày 12", htmlBody: "<p></p>", textBody: "" });
        await pool.query(`UPDATE email_deliveries SET status = 'unknown', provider_message_id = 'msg-known' WHERE digest_id = $1`, [d3.id]);
        assert.equal((await h.delivery(reconciler).deliver(d3.id)).status, "sent");
        assert.equal(reconciler.attempts.length, 0, "reconciled without resending");
        assert.equal((await h.store.getDelivery(d3.id))!.status, "delivered");

        // Permanent (auth/sender) failure: failed, Digest failed, no retry scheduled.
        const denied = new FakeEmailProvider(() => {
          throw new EmailProviderError("EMAIL_AUTH_ERROR", "denied");
        });
        const d4 = (await h.generation.generate({ userId: h.userId, localDate: "2026-11-09", mode: "finalize" })).digest;
        assert.deepEqual(await h.delivery(denied).deliver(d4.id), { status: "failed", errorCode: "EMAIL_AUTH_ERROR" });
        assert.equal((await h.store.getDigest(d4.id))!.status, "failed");
        assert.equal(await count(pool, `SELECT COUNT(*) n FROM outbox_events WHERE event_key LIKE $1`, [`${DIGEST_DELIVER_EVENT}:${d4.id}:%`]), 0);

        // Retries are bounded: always-503 stops after maxAttempts.
        const down = new FakeEmailProvider(() => {
          throw new EmailProviderError("EMAIL_PROVIDER_UNAVAILABLE", "down");
        });
        const d5 = (await h.generation.generate({ userId: h.userId, localDate: "2026-11-08", mode: "finalize" })).digest;
        const outcomes = [];
        for (let attempt = 0; attempt < POLICY.maxAttempts + 1; attempt += 1) outcomes.push((await h.delivery(down).deliver(d5.id)).status);
        assert.deepEqual(outcomes, ["retry_scheduled", "retry_scheduled", "failed", "failed"]);
        assert.equal(down.attempts.length, POLICY.maxAttempts + 1, "manual re-delivery of a failed Digest is still possible but each run is one bounded attempt");
        assert.equal((await h.store.getDigest(d5.id))!.status, "failed");

        // Sender not configured: no email row, Digest failed.
        const noSender = new DigestDeliveryService({ store: h.store, email: new FakeEmailProvider(), from: undefined, logger: silentProcessingLogger, policy: POLICY });
        const d6 = (await h.generation.generate({ userId: h.userId, localDate: "2026-11-07", mode: "finalize" })).digest;
        assert.deepEqual(await noSender.deliver(d6.id), { status: "failed", errorCode: "EMAIL_NOT_CONFIGURED" });
        assert.equal(await h.store.getDelivery(d6.id), null);
      });
    });

    await t.test("Test 9 — scheduler runs twice + restart → one Digest, one email (real pg-boss + outbox)", async () => {
      await withIsolatedSchema(async (pool, schema) => {
        const h = await createHarness(pool);
        await h.addEvent({ title: "Bão X", articles: [{ source: h.sources.vtv, title: "Bão X", publishedAt: jst(12, 9) }] });
        const email = new FakeEmailProvider();
        const queue = new PostgresJobQueue(databaseUrl!, () => undefined, schema);
        const deps: DigestJobDeps = {
          queue,
          store: h.store,
          generation: h.generation,
          delivery: h.delivery(email),
          enqueueCollectAll: async () => 0,
          logger: silentProcessingLogger,
          now: () => new Date(jst(13, 6, 45)), // the 06:45 JST tick on the 13th
        };
        const dispatcher = new OutboxDispatcher(pool, {
          [DIGEST_READY_EVENT]: async (payload) => void (await enqueueDigestDelivery(queue, (payload as { digestId: string }).digestId)),
        });
        const waitFor = async (predicate: () => Promise<boolean>) => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            if (await predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.fail("timed out");
        };
        try {
          await queue.start();
          await registerDigestJobs(deps);
          await startDigestScheduler(deps); // registers crons + catch-up finalize
          await startDigestScheduler(deps); // restart: same schedules, catch-up again
          await fanOutGeneration(deps, "finalize"); // the cron tick firing as well

          const schedules = await pool.query<{ name: string; cron: string; timezone: string }>(`SELECT name, cron, timezone FROM "${schema}".schedule ORDER BY name`);
          assert.deepEqual(schedules.rows, [
            { name: "schedule-collect-sources", cron: "30 5 * * *", timezone: "Asia/Tokyo" },
            { name: "schedule-digest-draft", cron: "0,30 6 * * *", timezone: "Asia/Tokyo" },
            { name: "schedule-digest-finalize", cron: "45 6 * * *", timezone: "Asia/Tokyo" },
          ]);

          await waitFor(async () => (await count(pool, `SELECT COUNT(*) n FROM daily_digests WHERE status = 'ready'`)) === 1);
          await new Promise((resolve) => setTimeout(resolve, 1_500)); // let the duplicate generate jobs finish
          assert.ok((await dispatcher.dispatchOnce()) >= 1);
          await waitFor(async () => (await count(pool, `SELECT COUNT(*) n FROM daily_digests WHERE status = 'sent'`)) === 1);
          await dispatcher.dispatchOnce();
          await new Promise((resolve) => setTimeout(resolve, 1_000));

          assert.equal(await count(pool, "SELECT COUNT(*) n FROM daily_digests"), 1);
          assert.equal(await count(pool, "SELECT COUNT(*) n FROM email_deliveries"), 1);
          assert.equal(email.sent.length, 1);
          assert.equal(email.sent[0]!.subject, "Tin nhanh ngày 12");
        } finally {
          await queue.stop();
        }
      });
    });

    await t.test("Test 10 — Cron-job.org ticks (retried, every 10 min, 05:40→07:15 JST) → one collection, one Digest, one email", async () => {
      await withIsolatedSchema(async (pool, schema) => {
        const h = await createHarness(pool);
        await h.addEvent({ title: "Bão X", articles: [{ source: h.sources.vtv, title: "Bão X", publishedAt: jst(12, 9) }] });
        const email = new FakeEmailProvider();
        const queue = new PostgresJobQueue(databaseUrl!, () => undefined, schema);
        let clock = new Date(jst(13, 5, 40));
        let collections = 0;
        const deps: DigestJobDeps = {
          queue,
          store: h.store,
          generation: h.generation,
          delivery: h.delivery(email),
          enqueueCollectAll: async () => {
            collections += 1;
            return 0;
          },
          logger: silentProcessingLogger,
          now: () => clock,
        };
        const dispatcher = new OutboxDispatcher(pool, {
          [DIGEST_READY_EVENT]: async (payload) => void (await enqueueDigestDelivery(queue, (payload as { digestId: string }).digestId)),
        });
        const settle = () => new Promise((resolve) => setTimeout(resolve, 1_500));
        const waitFor = async (predicate: () => Promise<boolean>) => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            if (await predicate()) return;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          assert.fail("timed out");
        };
        const jobs = (name: string) => count(pool, `SELECT COUNT(*) n FROM "${schema}".job WHERE name = $1`, [name]);
        try {
          await queue.start();
          await registerDigestJobs(deps);

          // 05:40 JST: collection window; a retried request is coalesced.
          const first = await runCronTick(deps);
          const retry = await runCronTick(deps);
          assert.equal(first.localDate, D);
          assert.deepEqual(first.operations.map((op) => [op.operation, Boolean(op.jobId)]), [["collect-sources", true]]);
          assert.deepEqual(retry.operations.map((op) => [op.operation, Boolean(op.jobId)]), [["collect-sources", false]]);

          // 06:10 JST: draft; collection already done today.
          clock = new Date(jst(13, 6, 10));
          const draft = await runCronTick(deps);
          assert.deepEqual(draft.operations.map((op) => [op.operation, Boolean(op.jobId)]), [["collect-sources", false], ["digest-draft", true]]);
          assert.equal((await runCronTick(deps)).operations[1]!.jobId, null, "retried draft tick coalesced");
          await waitFor(async () => collections === 1 && (await count(pool, `SELECT COUNT(*) n FROM daily_digests`)) === 1);
          assert.equal((await pool.query<{ status: string }>("SELECT status FROM daily_digests")).rows[0]!.status, "building", "draft only");

          // 07:05 JST: finalize (+ retries), digest.ready → delivery; 07:15: another finalize tick (recovery path).
          clock = new Date(jst(13, 7, 5));
          assert.deepEqual((await runCronTick(deps)).operations.map((op) => [op.operation, Boolean(op.jobId)]), [["digest-finalize", true]]);
          assert.equal((await runCronTick(deps)).operations[0]!.jobId, null);
          await waitFor(async () => (await count(pool, `SELECT COUNT(*) n FROM daily_digests WHERE status <> 'building'`)) === 1);
          await settle();
          await dispatcher.dispatchOnce();
          clock = new Date(jst(13, 7, 15));
          await runCronTick(deps);
          await waitFor(async () => (await count(pool, `SELECT COUNT(*) n FROM daily_digests WHERE status = 'sent'`)) === 1);
          await settle();
          await dispatcher.dispatchOnce();
          await settle();

          assert.equal(collections, 1, "one collection per JST day");
          assert.equal(await jobs("schedule-collect-sources"), 1);
          assert.equal(await count(pool, "SELECT COUNT(*) n FROM daily_digests"), 1);
          assert.equal((await pool.query<{ status: string }>("SELECT status FROM daily_digests")).rows[0]!.status, "sent");
          assert.equal(await count(pool, "SELECT COUNT(*) n FROM email_deliveries"), 1);
          assert.equal(email.sent.length, 1);
          assert.equal(email.sent[0]!.subject, "Tin nhanh ngày 12");
        } finally {
          await queue.stop();
        }
      });
    });

    await t.test("a crashed deliver-digest job is recovered by the next finalize run (exactly one email)", async () => {
      await withIsolatedSchema(async (pool, schema) => {
        const h = await createHarness(pool);
        await h.addEvent({ title: "Bão X", articles: [{ source: h.sources.vtv, title: "Bão X", publishedAt: jst(12, 9) }] });
        // Frozen and its digest.ready outbox row already dispatched, but the delivery job crashed: no email row.
        const built = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        await pool.query(`UPDATE outbox_events SET status = 'dispatched' WHERE event_type = $1`, [DIGEST_READY_EVENT]);
        assert.equal(await h.store.getDelivery(built.digest.id), null);

        const email = new FakeEmailProvider();
        const queue = new PostgresJobQueue(databaseUrl!, () => undefined, schema);
        const deps: DigestJobDeps = {
          queue,
          store: h.store,
          generation: h.generation,
          delivery: h.delivery(email),
          enqueueCollectAll: async () => 0,
          logger: silentProcessingLogger,
          now: () => new Date(jst(13, 10, 0)), // after 07:00 JST
        };
        try {
          await queue.start();
          await registerDigestJobs(deps);
          await fanOutGeneration(deps, "finalize"); // restart catch-up
          await fanOutGeneration(deps, "finalize"); // and again
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline && (await h.store.getDigest(built.digest.id))!.status !== "sent") {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          await new Promise((resolve) => setTimeout(resolve, 1_500));
          assert.equal((await h.store.getDigest(built.digest.id))!.status, "sent");
          assert.equal(email.sent.length, 1);
          assert.equal(await count(pool, "SELECT COUNT(*) n FROM email_deliveries"), 1);
        } finally {
          await queue.stop();
        }
      });
    });

    await t.test("Settings, Digest, Preview, Dashboard API and signed Resend webhook", async () => {
      await withIsolatedSchema(async (pool) => {
        const authStore = createAuthStore(pool);
        const adminEmail = `phase6-api-${randomBytes(4).toString("hex")}@example.com`;
        const password = "phase6-api-test-password";
        const admin = await new AuthService(authStore).provisionAdmin(adminEmail, password);
        const h = await createHarness(pool, admin.user.id);
        await h.addEvent({ title: "Bão X đổ bộ", articles: [{ source: h.sources.vtv, title: "Bão X", publishedAt: jst(12, 9) }] });
        const built = await h.generation.generate({ userId: h.userId, localDate: D, mode: "finalize" });
        const webhookSecret = `whsec_${Buffer.from("integration-webhook-secret").toString("base64")}`;
        const app = buildApp({
          authStore,
          digestApi: new DefaultDigestApi(h.store),
          resendWebhook: { secret: webhookSecret, apply: (input) => h.store.applyDeliveryWebhook(input) },
        });
        try {
          const csrf = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token as string;
          const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: adminEmail, password }, headers: { "x-csrf-token": csrf, cookie: `aidnd_csrf=${csrf}` } });
          const session = login.cookies.find((cookie) => cookie.name === "aidnd_session")!.value;
          const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: `aidnd_session=${session}` } });
          const token = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token as string;
          const patch = (payload: unknown, withCsrf = true) =>
            app.inject({
              method: "PATCH",
              url: "/api/v1/settings",
              payload: payload as Record<string, unknown>,
              headers: withCsrf ? { cookie: `aidnd_session=${session}; aidnd_csrf=${token}`, "x-csrf-token": token } : { cookie: `aidnd_session=${session}` },
            });

          // Settings
          assert.equal((await app.inject({ method: "GET", url: "/api/v1/settings" })).statusCode, 401);
          assert.deepEqual((await get("/api/v1/settings")).json(), { recipientEmail: adminEmail, timezone: "Asia/Tokyo", sendLocalTime: "07:00" });
          assert.equal((await patch({ recipientEmail: RECIPIENT_B }, false)).statusCode, 403);
          const invalid = await patch({ recipientEmail: "nope" });
          assert.deepEqual([invalid.statusCode, invalid.json().error.message], [400, "Enter a valid email address."]);
          assert.equal((await patch({ recipientEmail: RECIPIENT_B, timezone: "UTC" })).statusCode, 400, "timezone is read-only");
          assert.equal((await patch({ recipientEmail: ` ${RECIPIENT_B.toUpperCase()} ` })).json().recipientEmail, RECIPIENT_B);

          // Digest API (before send)
          const list = (await get("/api/v1/digests")).json();
          assert.equal(list.total, 1);
          assert.deepEqual(
            [list.items[0].localDate, list.items[0].status, list.items[0].eventCount, list.items[0].isEmpty, list.items[0].deliveryStatus, list.items[0].subject],
            [D, "ready", 1, false, null, "Tin nhanh ngày 12"],
          );
          const detail = (await get(`/api/v1/digests/${built.digest.id}`)).json();
          assert.equal(detail.displayDate, "12/11/2026");
          assert.equal(detail.events[0].titleVi, "Bão X đổ bộ");
          const preview = (await get(`/api/v1/digests/${built.digest.id}/preview`)).json();
          assert.ok(preview.html.includes("Tin nhanh ngày 12/11/2026"));
          assert.equal(await count(pool, "SELECT COUNT(*) n FROM email_deliveries"), 0, "preview never sends");
          assert.equal((await get("/api/v1/digests/not-a-uuid")).statusCode, 404);

          // Send, then the API reflects it; preview uses the frozen email content.
          const email = new FakeEmailProvider();
          await h.delivery(email).deliver(built.digest.id);
          assert.equal(email.sent[0]!.to, RECIPIENT_B);
          assert.equal((await get(`/api/v1/digests/${built.digest.id}/preview`)).json().html, email.sent[0]!.html, "preview == sent email");
          const dashboard = (await get("/api/v1/dashboard/summary")).json();
          assert.deepEqual([dashboard.activeSources, dashboard.eventsDetected, dashboard.latestDigest.status, dashboard.latestDigest.deliveryStatus], [3, 1, "sent", "accepted"]);
          assert.match(dashboard.nextDigest.sendAt, /T22:00:00\.000Z$/, "next send is 07:00 JST");
          const apiText = JSON.stringify([list, detail, dashboard]);
          assert.ok(!/resend|re_|api[_-]?key|whsec|provider_message|idempotency/i.test(apiText), "no provider internals in API responses");

          // Signed webhook → delivered; duplicate ignored; bad signature rejected.
          const messageId = email.sent[0]!.providerMessageId;
          const body = JSON.stringify({ type: "email.delivered", data: { email_id: messageId } });
          const timestamp = String(Math.floor(Date.now() / 1000));
          const signature = `v1,${createHmac("sha256", Buffer.from("integration-webhook-secret")).update(`evt_42.${timestamp}.${body}`).digest("base64")}`;
          const webhook = (sig: string) =>
            app.inject({ method: "POST", url: "/api/v1/webhooks/resend", payload: body, headers: { "content-type": "application/json", "svix-id": "evt_42", "svix-timestamp": timestamp, "svix-signature": sig } });
          assert.equal((await webhook("v1,forged")).statusCode, 401);
          assert.deepEqual((await webhook(signature)).json(), { received: true, applied: true });
          assert.deepEqual((await webhook(signature)).json(), { received: true, applied: false }, "duplicate webhook ignored");
          assert.equal((await h.store.getDelivery(built.digest.id))!.status, "delivered");
        } finally {
          await app.close();
        }
      });
    });
  },
);
