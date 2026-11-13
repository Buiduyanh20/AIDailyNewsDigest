import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { test } from "node:test";

import { createPostgresRepositories } from "./repositories.js";
import { runMigrations } from "./migrate.js";
import { PostgresJobQueue } from "../queue/job-queue.js";
import { ConflictError, InfrastructureError } from "../errors/index.js";
import { buildApp } from "../app.js";
import { AuthService } from "../auth/service.js";
import { createAuthStore } from "./auth-store.js";
import { SourceService } from "../sources/service.js";
import { registerSourceCollectionWorker, SOURCE_COLLECTION_QUEUE } from "../sources/worker.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), override: false });
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

async function withIsolatedSchema<T>(work: (pool: Pool, schema: string) => Promise<T>): Promise<T> {
  if (!databaseUrl) {
    throw new Error("A PostgreSQL test URL is required.");
  }

  const schema = `phase3_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  let testPool: Pool | undefined;
  let schemaCreated = false;

  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    testPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    return await work(testPool, schema);
  } finally {
    await testPool?.end();
    if (schemaCreated) {
      await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await adminPool.end();
  }
}

function expectConflict(promise: Promise<unknown>): Promise<void> {
  return assert.rejects(promise, (error: unknown) => error instanceof ConflictError);
}

test(
  "PostgreSQL Phase 3 migration, constraints, repository, transaction, outbox, and pg-boss foundations",
  { skip: databaseUrl ? false : "Set TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests." },
  async (t) => {
    await t.test("migrations apply cleanly to an empty schema and are repeatable", async () => {
      await withIsolatedSchema(async (pool) => {
        await runMigrations(pool);
        await runMigrations(pool);

        const tables = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
           WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
           ORDER BY table_name`,
        );
        assert.deepEqual(
          tables.rows.map((row) => row.table_name),
          [
            "articles",
            "daily_digests",
            "digest_events",
            "email_deliveries",
            "email_webhook_events",
            "event_articles",
            "events",
            "outbox_events",
            "processing_attempts",
            "schema_migrations",
            "sessions",
            "sources",
            "user_settings",
            "users",
          ],
        );

        const versions = await pool.query<{ version: string }>(
          "SELECT version FROM schema_migrations ORDER BY version",
        );
        assert.deepEqual(versions.rows.map((row) => row.version), [
          "001_phase2_auth",
          "002_phase3_foundation",
          "003_phase5_ai",
          "004_phase6_digest",
        ]);
        const sourceIndexes = await pool.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = current_schema() AND tablename = 'sources'
           ORDER BY indexname`,
        );
        assert.deepEqual(
          sourceIndexes.rows.map((row) => row.indexname),
          [
            "sources_pkey",
            "sources_status_idx",
            "sources_user_deleted_idx",
            "sources_user_enabled_idx",
            "sources_user_id_idx",
          ],
        );
      });
    });

    await t.test("migrations upgrade an existing Phase 2 schema without losing rows", async () => {
      await withIsolatedSchema(async (pool) => {
        const phase2Migration = await readFile(new URL("../../migrations/001_phase2_auth.sql", import.meta.url), "utf8");
        await pool.query(phase2Migration);
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
          ["kept-phase2-user@example.com", "existing-hash"],
        );

        await runMigrations(pool);

        const preserved = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [
          "kept-phase2-user@example.com",
        ]);
        assert.equal(preserved.rows[0]?.id, inserted.rows[0]?.id);
      });
    });

    await t.test("repositories preserve soft-deleted history and enforce schema constraints", async () => {
      await withIsolatedSchema(async (pool) => {
        await runMigrations(pool);
        const repositories = createPostgresRepositories(pool);
        const user = await repositories.users.create({
          email: "repository-test@example.com",
          passwordHash: "test-hash",
        });
        const source = await repositories.sources.create({
          userId: user.id,
          name: "Example source",
          websiteUrl: "https://example.com",
          rssUrl: "https://example.com/feed.xml",
        });
        const article = await repositories.articles.create({
          sourceId: source.id,
          originalUrl: "https://example.com/article",
          originalTitle: "Example article",
          publishedDateJst: "2026-11-11",
        });
        const firstEvent = await repositories.events.create({
          userId: user.id,
          titleVi: "Sự kiện đầu tiên",
          status: "active",
          processingStatus: "pending",
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
        const secondEvent = await repositories.events.create({
          userId: user.id,
          titleVi: "Sự kiện thứ hai",
          status: "active",
          processingStatus: "pending",
          firstSeenAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });

        await repositories.eventArticles.create({
          eventId: firstEvent.id,
          articleId: article.id,
          associationMethod: "manual",
        });
        await expectConflict(
          repositories.eventArticles.create({
            eventId: secondEvent.id,
            articleId: article.id,
            associationMethod: "manual",
          }),
        );

        const digest = await repositories.dailyDigests.create({
          userId: user.id,
          localDate: "2026-11-11",
          // Snapshots can only be written while a Digest is building (Phase 6 immutability guard).
          status: "building",
        });
        await expectConflict(
          repositories.dailyDigests.create({
            userId: user.id,
            localDate: "2026-11-11",
            status: "scheduled",
          }),
        );

        const snapshot = await repositories.digestEvents.create({
          digestId: digest.id,
          eventId: firstEvent.id,
          position: 1,
          titleViSnapshot: "Snapshot title",
          summaryViSnapshot: "Snapshot summary",
          articleSnapshot: [
            {
              articleId: article.id,
              sourceId: source.id,
              originalTitle: article.originalTitle,
              originalUrl: article.originalUrl,
            },
          ],
          sourceSnapshot: [
            {
              sourceId: source.id,
              name: source.name,
              websiteUrl: source.websiteUrl,
              rssUrl: source.rssUrl,
            },
          ],
        });
        await expectConflict(
          repositories.digestEvents.create({ ...snapshot, eventId: firstEvent.id }),
        );
        await expectConflict(
          repositories.digestEvents.create({
            ...snapshot,
            eventId: secondEvent.id,
          }),
        );

        const delivery = await repositories.emailDeliveries.create({
          digestId: digest.id,
          idempotencyKey: "delivery-key-1",
        });
        await expectConflict(
          repositories.emailDeliveries.create({
            digestId: digest.id,
            idempotencyKey: "delivery-key-2",
          }),
        );
        const secondDigest = await repositories.dailyDigests.create({
          userId: user.id,
          localDate: "2026-11-12",
          status: "scheduled",
        });
        await expectConflict(
          repositories.emailDeliveries.create({
            digestId: secondDigest.id,
            idempotencyKey: delivery.idempotencyKey,
          }),
        );

        const attempt = await repositories.processingAttempts.create({
          entityType: "article",
          entityId: article.id,
          operation: "foundation-test",
          attemptNumber: 1,
          status: "pending",
          estimatedCost: "0.125000",
        });
        assert.equal(
          (await repositories.processingAttempts.listByEntity("article", article.id))[0]?.id,
          attempt.id,
        );

        // PostgreSQL DATE values must round-trip exactly (no host-timezone shift).
        assert.equal((await repositories.articles.findById(article.id))?.publishedDateJst, "2026-11-11");
        const boundaryArticle = await repositories.articles.create({
          sourceId: source.id,
          originalUrl: "https://example.com/boundary",
          originalTitle: "Boundary article",
          publishedAt: "2026-11-11T15:00:00Z",
          publishedDateJst: "2026-11-12",
        });
        assert.equal((await repositories.articles.findById(boundaryArticle.id))?.publishedDateJst, "2026-11-12");
        assert.equal((await repositories.dailyDigests.findByUserAndDate(user.id, "2026-11-11"))?.localDate, "2026-11-11");

        const deletedSource = await repositories.sources.softDelete(source.id, user.id);
        assert.equal(deletedSource?.enabled, false);
        assert.ok(deletedSource?.deletedAt);
        assert.equal((await repositories.articles.findById(article.id))?.id, article.id);
        await pool.query("UPDATE sources SET name = 'Changed current name' WHERE id = $1", [source.id]);
        const persistedSnapshot = (await repositories.digestEvents.listByDigest(digest.id))[0];
        assert.equal(persistedSnapshot?.titleViSnapshot, "Snapshot title");
        assert.equal(persistedSnapshot?.sourceSnapshot[0]?.name, "Example source");
        for (const [sql, id] of [
          ["DELETE FROM sources WHERE id = $1", source.id],
          ["DELETE FROM articles WHERE id = $1", article.id],
          ["DELETE FROM events WHERE id = $1", firstEvent.id],
          ["DELETE FROM daily_digests WHERE id = $1", digest.id],
        ]) {
          await assert.rejects(pool.query(sql, [id]), (error: unknown) => {
            return (error as { code?: string }).code === "23503";
          });
        }
      });
    });

    await t.test("a transaction commits or rolls back business and outbox rows together", async () => {
      await withIsolatedSchema(async (pool) => {
        await runMigrations(pool);
        const repositories = createPostgresRepositories(pool);
        const user = await repositories.users.create({
          email: "outbox-test@example.com",
          passwordHash: "test-hash",
        });
        const committed = await repositories.transactions.transaction(async (tx) => {
          const event = await repositories.events.create(
            {
              userId: user.id,
              titleVi: "Committed event",
              status: "active",
              processingStatus: "pending",
              firstSeenAt: new Date().toISOString(),
              lastSeenAt: new Date().toISOString(),
            },
            tx,
          );
          const outbox = await repositories.outboxEvents.create(
            {
              eventKey: "event-created:committed",
              eventType: "event.created",
              aggregateType: "event",
              aggregateId: event.id,
              payload: { eventId: event.id },
            },
            tx,
          );
          return { event, outbox };
        });
        assert.equal((await repositories.events.findByIdForUser(committed.event.id, user.id))?.id, committed.event.id);
        assert.equal((await repositories.outboxEvents.findByEventKey(committed.outbox.eventKey))?.id, committed.outbox.id);
        await expectConflict(
          repositories.transactions.transaction((tx) =>
            repositories.outboxEvents.create(
              {
                eventKey: committed.outbox.eventKey,
                eventType: "event.created",
                aggregateType: "event",
                aggregateId: committed.event.id,
                payload: { eventId: committed.event.id },
              },
              tx,
            ),
          ),
        );
        await assert.rejects(
          pool.query(
            `INSERT INTO daily_digests (user_id, local_date, status)
             VALUES ($1, $2, 'empty')`,
            [user.id, "2026-11-13"],
          ),
          (error: unknown) => (error as { code?: string }).code === "23514",
        );

        let rolledBackEventId = "";
        await assert.rejects(
          repositories.transactions.transaction(async (tx) => {
            const event = await repositories.events.create(
              {
                userId: user.id,
                titleVi: "Rolled back event",
                status: "active",
                processingStatus: "pending",
                firstSeenAt: new Date().toISOString(),
                lastSeenAt: new Date().toISOString(),
              },
              tx,
            );
            rolledBackEventId = event.id;
            await repositories.outboxEvents.create(
              {
                eventKey: "event-created:rolled-back",
                eventType: "event.created",
                aggregateType: "event",
                aggregateId: event.id,
                payload: { eventId: event.id },
              },
              tx,
            );
            throw new Error("force rollback");
          }),
          InfrastructureError,
        );
        assert.equal(await repositories.events.findByIdForUser(rolledBackEventId, user.id), null);
        assert.equal(await repositories.outboxEvents.findByEventKey("event-created:rolled-back"), null);
      });
    });

    await t.test("Phase 2 login, session, protected route, and logout persist in PostgreSQL", async () => {
      await withIsolatedSchema(async (pool) => {
        await runMigrations(pool);
        const store = createAuthStore(pool);
        const authService = new AuthService(store);
        const email = `phase2-postgres-${randomBytes(6).toString("hex")}@example.com`;
        const password = "postgres-auth-test-password";
        await authService.provisionAdmin(email, password);
        const app = buildApp({ authStore: store });

        try {
          const csrfResponse = await app.inject({ method: "GET", url: "/api/v1/auth/csrf" });
          const token = csrfResponse.json().token as string;
          const login = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email, password },
            headers: { "x-csrf-token": token, cookie: `aidnd_csrf=${token}` },
          });
          assert.equal(login.statusCode, 200);
          const sessionCookie = login.cookies.find((cookie) => cookie.name === "aidnd_session");
          assert.ok(sessionCookie);

          const session = await app.inject({
            method: "GET",
            url: "/api/v1/auth/session",
            headers: { cookie: `aidnd_session=${sessionCookie.value}` },
          });
          assert.equal(session.statusCode, 200);
          const protectedResponse = await app.inject({
            method: "GET",
            url: "/api/v1/protected",
            headers: { cookie: `aidnd_session=${sessionCookie.value}` },
          });
          assert.equal(protectedResponse.statusCode, 200);

          const logout = await app.inject({
            method: "POST",
            url: "/api/v1/auth/logout",
            headers: {
              "x-csrf-token": token,
              cookie: `aidnd_session=${sessionCookie.value}; aidnd_csrf=${token}`,
            },
          });
          assert.equal(logout.statusCode, 200);
          const revoked = await app.inject({
            method: "GET",
            url: "/api/v1/auth/session",
            headers: { cookie: `aidnd_session=${sessionCookie.value}` },
          });
          assert.equal(revoked.statusCode, 401);
        } finally {
          await app.close();
        }
      });
    });

    await t.test("pg-boss initializes, enqueues a foundation job, and shuts down", async () => {
      await withIsolatedSchema(async (_pool, schema) => {
        const queue = new PostgresJobQueue(databaseUrl!, () => undefined, schema);
        try {
          await queue.start();
          assert.equal(queue.isReady, true);
          const jobId = await queue.enqueue("phase3-foundation-test", { verification: true });
          assert.ok(jobId);
        } finally {
          await queue.stop();
        }
        assert.equal(queue.isReady, false);
      });
    });

    await t.test("normal source queries exclude soft-deleted sources from filters and pagination", async () => {
      await withIsolatedSchema(async (pool) => {
        await runMigrations(pool);
        const repositories = createPostgresRepositories(pool);
        const user = await repositories.users.create({
          email: "source-list-test@example.com",
          passwordHash: "test-hash",
        });
        const active = await repositories.sources.create({
          userId: user.id,
          name: "Alpha Feed",
          websiteUrl: "https://alpha.example.com",
          enabled: true,
        });
        const disabled = await repositories.sources.create({
          userId: user.id,
          name: "Beta Feed",
          websiteUrl: "https://beta.example.com",
          enabled: true,
        });
        const deleted = await repositories.sources.create({
          userId: user.id,
          name: "Gone Feed",
          websiteUrl: "https://gone.example.com",
          enabled: true,
        });
        await repositories.sources.update(disabled.id, user.id, { enabled: false });
        await repositories.sources.softDelete(deleted.id, user.id);

        const all = await repositories.sources.listForUser(user.id);
        assert.equal(all.total, 2);
        assert.deepEqual(new Set(all.items.map((source) => source.id)), new Set([active.id, disabled.id]));

        const activeOnly = await repositories.sources.listForUser(user.id, { status: "active" });
        assert.deepEqual(activeOnly.items.map((source) => source.id), [active.id]);

        const disabledOnly = await repositories.sources.listForUser(user.id, { status: "disabled" });
        assert.deepEqual(disabledOnly.items.map((source) => source.id), [disabled.id]);

        const deletedSearch = await repositories.sources.listForUser(user.id, { search: "gone", pageSize: 1 });
        assert.equal(deletedSearch.total, 0);
        assert.deepEqual(deletedSearch.items, []);

        const firstPage = await repositories.sources.listForUser(user.id, { page: 1, pageSize: 1 });
        assert.equal(firstPage.total, 2);
        assert.equal(firstPage.items.length, 1);
        assert.equal(await repositories.sources.findByIdForUser(deleted.id, user.id), null);
      });
    });

    await t.test("collect-source worker persists feed updates and records failures and recovery", async () => {
      await withIsolatedSchema(async (pool, schema) => {
        await runMigrations(pool);
        const repositories = createPostgresRepositories(pool);
        const user = await repositories.users.create({
          email: "source-worker-test@example.com",
          passwordHash: "test-hash",
        });

        const feedItem = (title: string, slug: string, guid: string, pubDate: string): string => `
          <item><title>${title}</title><link>https://example.com/${slug}</link>
          <guid>${guid}</guid><description>${title}</description><pubDate>${pubDate}</pubDate></item>`;
        let feed = `<?xml version="1.0"?><rss version="2.0"><channel>
          <title>Worker test feed</title><link>https://example.com</link>
          ${feedItem("Phase 4 Article A", "article-a", "phase4-a", "Wed, 11 Nov 2026 15:30:00 GMT")}
        </channel></rss>`;
        let invalidFeed = false;
        const fixtureServer = createServer((_request, response) => {
          if (invalidFeed) {
            response.writeHead(500, { "content-type": "text/plain" });
            response.end("fixture failure");
            return;
          }
          response.writeHead(200, { "content-type": "application/rss+xml" });
          response.end(feed);
        });
        const queue = new PostgresJobQueue(databaseUrl!, () => undefined, schema);

        const waitUntil = async (condition: () => Promise<boolean>): Promise<void> => {
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline) {
            if (await condition()) return;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          assert.fail("Timed out waiting for the collection worker.");
        };

        try {
          await new Promise<void>((resolve, reject) => {
            fixtureServer.once("error", reject);
            fixtureServer.listen(0, "127.0.0.1", resolve);
          });
          const address = fixtureServer.address() as AddressInfo;
          const source = await repositories.sources.create({
            userId: user.id,
            name: "Worker test feed",
            websiteUrl: "https://example.com",
            rssUrl: `http://127.0.0.1:${address.port}/feed.xml`,
            enabled: true,
          });
          const sourceService = new SourceService({
            sources: repositories.sources,
            articles: repositories.articles,
            enqueueCollection: (sourceId) =>
              queue.enqueue(SOURCE_COLLECTION_QUEUE, { sourceId }, { retryLimit: 0 }),
          });

          await queue.start();
          await registerSourceCollectionWorker(queue, sourceService);

          const firstJob = await sourceService.retrySource(user.id, source.id);
          assert.equal(firstJob.status, "queued");
          assert.ok(firstJob.jobId);
          await waitUntil(async () => (await repositories.articles.listBySource(source.id)).length === 1);

          const firstArticle = (await repositories.articles.listBySource(source.id))[0];
          assert.equal(firstArticle?.externalId, "phase4-a");
          assert.equal(firstArticle?.processingStatus, "pending");

          feed = `<?xml version="1.0"?><rss version="2.0"><channel>
            <title>Worker test feed</title><link>https://example.com</link>
            ${feedItem("Phase 4 Article A", "article-a", "phase4-a", "Wed, 11 Nov 2026 15:30:00 GMT")}
            ${feedItem("Phase 4 Article B", "article-b", "phase4-b", "Wed, 11 Nov 2026 16:30:00 GMT")}
          </channel></rss>`;
          const secondJob = await sourceService.retrySource(user.id, source.id);
          assert.ok(secondJob.jobId);
          await waitUntil(async () => {
            const articles = await repositories.articles.listBySource(source.id);
            return articles.some((article) => article.externalId === "phase4-b");
          });
          let articles = await repositories.articles.listBySource(source.id);
          assert.equal(articles.filter((article) => article.externalId === "phase4-a").length, 1);
          assert.equal(articles.filter((article) => article.externalId === "phase4-b").length, 1);
          let refreshedSource = await repositories.sources.findById(source.id);
          assert.equal(refreshedSource?.status, "active");
          assert.ok(refreshedSource?.lastFetchedAt);

          invalidFeed = true;
          const failedJob = await sourceService.retrySource(user.id, source.id);
          assert.ok(failedJob.jobId);
          await waitUntil(async () => (await repositories.sources.findById(source.id))?.status === "error");
          refreshedSource = await repositories.sources.findById(source.id);
          assert.ok(refreshedSource?.lastErrorCode);
          assert.ok(refreshedSource?.lastErrorAt);

          invalidFeed = false;
          const recoveryJob = await sourceService.retrySource(user.id, source.id);
          assert.ok(recoveryJob.jobId);
          await waitUntil(async () => {
            const current = await repositories.sources.findById(source.id);
            return current?.status === "active" && current.lastErrorCode === null;
          });
          articles = await repositories.articles.listBySource(source.id);
          assert.equal(articles.length, 2);
        } finally {
          await queue.stop();
          await new Promise<void>((resolve, reject) => {
            fixtureServer.close((error) => (error ? reject(error) : resolve()));
          });
        }
      });
    });
  },
);
