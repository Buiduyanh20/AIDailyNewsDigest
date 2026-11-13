import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { config } from "dotenv";
import { Pool } from "pg";

import { countSentences, type Source } from "@aidnd/domain";

import { loadEvalDataset } from "../ai/eval/dataset.js";
import { FakeAIProvider, readPromptPayload } from "../ai/fake-provider.js";
import { GeminiProvider } from "../ai/gemini-provider.js";
import { AIProviderError, type AIRequest } from "../ai/provider.js";
import { buildApp } from "../app.js";
import { AuthService } from "../auth/service.js";
import { createAuthStore } from "../db/auth-store.js";
import { runMigrations } from "../db/migrate.js";
import { createPostgresRepositories, type PostgresRepositories } from "../db/repositories.js";
import { ARTICLE_CREATED_EVENT, OutboxDispatcher, articleIdFromPayload } from "../outbox/dispatcher.js";
import { PostgresJobQueue } from "../queue/job-queue.js";
import { backfillArticleLanguages } from "../sources/language-backfill.js";
import { ArticleProcessor, DEFAULT_CANDIDATE_POOL_SIZE, silentProcessingLogger } from "./processor.js";
import { DefaultEventService } from "./service.js";
import { PostgresEventProcessingStore, PostgresEventReadStore } from "./store.js";
import { enqueueArticleProcessing, registerArticleProcessingWorker } from "./worker.js";

config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)), override: false });
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

async function withIsolatedSchema<T>(work: (pool: Pool, schema: string) => Promise<T>): Promise<T> {
  const schema = `phase5_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: databaseUrl });
  let testPool: Pool | undefined;
  let created = false;
  try {
    await adminPool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    testPool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    await runMigrations(testPool);
    return await work(testPool, schema);
  } finally {
    await testPool?.end();
    if (created) await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await adminPool.end();
  }
}

// ---------------------------------------------------------------------------
// Deterministic fixtures + fake AI "oracle"
// ---------------------------------------------------------------------------

type Story = "typhoon" | "economy" | "officialRemarks" | "otherReport";

const STORY_TEXT: Record<Story, { titleVi: string; summaryVi: string }> = {
  typhoon: {
    titleVi: "Bão X đổ bộ miền Trung, gây mưa lớn",
    summaryVi:
      "Bão X đã đổ bộ vào các tỉnh miền Trung Việt Nam chiều 11/11. Mưa lớn gây ngập úng tại nhiều khu vực. Chính quyền địa phương đã sơ tán hàng nghìn hộ dân.",
  },
  economy: {
    titleVi: "Nhật Bản công bố chính sách kinh tế mới",
    summaryVi:
      "Chính phủ Nhật Bản đã công bố gói chính sách kinh tế mới. Gói chính sách tập trung vào việc hỗ trợ hộ gia đình trước tình trạng giá cả tăng cao.",
  },
  officialRemarks: {
    titleVi: "Một quan chức phát biểu về tình hình kinh tế",
    summaryVi: "Một quan chức đã có phát biểu về tình hình kinh tế hiện nay. Bài viết không nêu chi tiết về chính sách cụ thể.",
  },
  otherReport: {
    titleVi: "Báo cáo mới đánh giá triển vọng kinh tế",
    summaryVi: "Một báo cáo mới đã đưa ra đánh giá về triển vọng kinh tế. Báo cáo được công bố bởi một tổ chức nghiên cứu.",
  },
};

type Fixture = {
  source: Source;
  title: string;
  language: string;
  publishedAt: string;
  story: Story;
  canonicalUrl?: string;
  excerpt?: string;
};

type Harness = {
  repositories: PostgresRepositories;
  userId: string;
  sources: Record<"vnexpress" | "vtv" | "nhk" | "cnn", Source>;
  storyOf: Map<string, Story>;
  uncertainArticles: Set<string>;
  addArticle(fixture: Fixture): Promise<string>;
  processor(ai: FakeAIProvider | GeminiProvider): ArticleProcessor;
  oracle(overrides?: { cluster?: (request: AIRequest) => unknown; summarize?: (request: AIRequest) => unknown }): FakeAIProvider;
  pool: Pool;
};

async function createHarness(pool: Pool, userId?: string): Promise<Harness> {
  const repositories = createPostgresRepositories(pool);
  const owner =
    userId ?? (await repositories.users.create({ email: `phase5-${randomBytes(6).toString("hex")}@example.com`, passwordHash: "x" })).id;
  const makeSource = (name: string, host: string) =>
    repositories.sources.create({ userId: owner, name, websiteUrl: `https://${host}`, rssUrl: `https://${host}/rss.xml` });
  const sources = {
    vnexpress: await makeSource("VnExpress", "vnexpress.example.com"),
    vtv: await makeSource("VTV", "vtv.example.com"),
    nhk: await makeSource("NHK", "nhk.example.com"),
    cnn: await makeSource("CNN", "cnn.example.com"),
  };
  const storyOf = new Map<string, Story>();
  const uncertainArticles = new Set<string>();

  const oracleCluster = (request: AIRequest) => {
    const payload = readPromptPayload<{
      article: { id: string };
      candidateEvents: Array<{ eventId: string; articles: Array<{ id: string }> }>;
    }>(request);
    const story = storyOf.get(payload.article.id);
    if (uncertainArticles.has(payload.article.id)) {
      return { decision: "uncertain", eventId: null, articleIds: [payload.article.id], reason: "Insufficient evidence." };
    }
    const match = payload.candidateEvents.find((candidate) => candidate.articles.some((member) => storyOf.get(member.id) === story));
    if (match) {
      return {
        decision: "merge",
        eventId: match.eventId,
        articleIds: [payload.article.id, match.articles[0]!.id],
        reason: "Same real-world event.",
        eventIdentity: { sameActors: true, sameAction: true, compatibleLocation: true, compatibleTime: true },
      };
    }
    return { decision: "new_event", eventId: null, articleIds: [payload.article.id], reason: "Different event." };
  };
  const oracleSummary = (request: AIRequest) => {
    const payload = readPromptPayload<{ articles: Array<{ id: string }> }>(request);
    const story = storyOf.get(payload.articles[0]!.id)!;
    return { ...STORY_TEXT[story], evidenceArticleIds: payload.articles.map((entry) => entry.id) };
  };

  return {
    repositories,
    userId: owner,
    sources,
    storyOf,
    uncertainArticles,
    pool,
    async addArticle(fixture) {
      const slug = randomBytes(5).toString("hex");
      const url = fixture.canonicalUrl ?? `${fixture.source.websiteUrl}/${slug}`;
      const created = await repositories.articles.create({
        sourceId: fixture.source.id,
        originalUrl: url,
        canonicalUrl: url,
        originalTitle: fixture.title,
        originalLanguage: fixture.language,
        originalExcerpt: fixture.excerpt ?? fixture.title,
        originalContent: fixture.excerpt ?? fixture.title,
        publishedAt: fixture.publishedAt,
        publishedDateJst: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(fixture.publishedAt)),
      });
      storyOf.set(created.id, fixture.story);
      return created.id;
    },
    processor(ai) {
      return new ArticleProcessor({
        store: new PostgresEventProcessingStore(pool),
        ai,
        config: { candidateWindowHours: 72, maxCandidates: 8 },
        retryHooks: { sleep: async () => undefined, random: () => 0.5 },
        logger: silentProcessingLogger,
      });
    },
    oracle(overrides = {}) {
      return new FakeAIProvider({
        cluster: overrides.cluster ?? oracleCluster,
        summarize: overrides.summarize ?? oracleSummary,
      });
    },
  };
}

async function eventOf(pool: Pool, articleId: string): Promise<{ eventId: string; method: string } | null> {
  const result = await pool.query<{ eventId: string; method: string }>(
    `SELECT event_id AS "eventId", association_method AS method FROM event_articles WHERE article_id = $1`,
    [articleId],
  );
  return result.rows[0] ?? null;
}

async function articleState(pool: Pool, articleId: string) {
  const result = await pool.query<{ status: string; errorCode: string | null; title: string; language: string | null }>(
    `SELECT processing_status AS status, processing_error_code AS "errorCode", original_title AS title,
            original_language AS language FROM articles WHERE id = $1`,
    [articleId],
  );
  return result.rows[0]!;
}

async function count(pool: Pool, sql: string, values: unknown[] = []): Promise<number> {
  return Number((await pool.query<{ count: string }>(sql, values)).rows[0]!.count);
}

const T = (hourUtc: number, minute = 0, day = 11) => new Date(Date.UTC(2026, 10, day, hourUtc, minute)).toISOString();

test(
  "Phase 5 AI processing with PostgreSQL and FakeAIProvider",
  { skip: databaseUrl ? false : "Set TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests." },
  async (t) => {
    await t.test("new Articles emit exactly one article.created outbox event", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const articleId = await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ", language: "vi", publishedAt: T(9), story: "typhoon" });
        const outbox = await pool.query<{ eventType: string; payload: { articleId: string } }>(
          `SELECT event_type AS "eventType", payload FROM outbox_events WHERE aggregate_id = $1`,
          [articleId],
        );
        assert.equal(outbox.rows.length, 1);
        assert.equal(outbox.rows[0]!.eventType, ARTICLE_CREATED_EVENT);
        assert.equal(outbox.rows[0]!.payload.articleId, articleId);
      });
    });

    await t.test("Test 1 — same event in Vietnamese becomes one Event", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const ai = h.oracle();
        const processor = h.processor(ai);
        const a = await h.addArticle({ source: h.sources.vnexpress, title: "Bão X đổ bộ miền Trung", language: "vi", publishedAt: T(9), story: "typhoon" });
        const b = await h.addArticle({ source: h.sources.vtv, title: "Bão X gây mưa lớn", language: "vi", publishedAt: T(9, 30), story: "typhoon" });

        const first = await processor.process(a);
        assert.equal(first.status, "processed");
        assert.equal(first.status === "processed" && first.decision, "no_candidates");
        assert.equal(ai.callsFor("event-clustering").length, 0, "no clustering call without candidates");

        const second = await processor.process(b);
        assert.equal(second.status === "processed" && second.decision, "merge");
        const eventA = await eventOf(pool, a);
        const eventB = await eventOf(pool, b);
        assert.equal(eventA?.eventId, eventB?.eventId);
        assert.equal(eventA?.method, "no_candidates");
        assert.equal(eventB?.method, "ai_merge");
        assert.equal(await count(pool, "SELECT COUNT(*) FROM events"), 1);
        assert.equal((await articleState(pool, b)).status, "processed");

        const attempts = await pool.query<{ operation: string; status: string; provider: string; model: string; promptVersion: string; decision: string | null; totalTokens: number }>(
          `SELECT operation, status, provider, model, prompt_version AS "promptVersion", decision, total_tokens AS "totalTokens"
           FROM processing_attempts WHERE entity_id = $1 ORDER BY created_at`,
          [b],
        );
        assert.deepEqual(attempts.rows.map((row) => [row.operation, row.status, row.decision]), [
          ["event-clustering", "succeeded", "merge"],
          ["event-summary", "succeeded", null],
        ]);
        assert.ok(attempts.rows.every((row) => row.provider === "fake" && row.model === "fake-model-v1" && row.totalTokens === 15));
        assert.equal(attempts.rows[0]!.promptVersion, "event-clustering-v2");
      });
    });

    await t.test("Test 2 — Vietnamese, Japanese, and English Articles form one Event; originals preserved", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const processor = h.processor(h.oracle());
        const ids = [
          await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ miền Trung", language: "vi", publishedAt: T(9), story: "typhoon" }),
          await h.addArticle({ source: h.sources.nhk, title: "台風Xがベトナム中部に上陸", language: "ja", publishedAt: T(10), story: "typhoon" }),
          await h.addArticle({ source: h.sources.cnn, title: "Typhoon X hits central Vietnam", language: "en", publishedAt: T(10, 30), story: "typhoon" }),
        ];
        for (const id of ids) assert.equal((await processor.process(id)).status, "processed");

        const eventIds = new Set(await Promise.all(ids.map(async (id) => (await eventOf(pool, id))!.eventId)));
        assert.equal(eventIds.size, 1);
        const event = (await pool.query<{ titleVi: string }>(`SELECT title_vi AS "titleVi" FROM events`)).rows[0]!;
        assert.equal(event.titleVi, STORY_TEXT.typhoon.titleVi);

        assert.deepEqual(await articleState(pool, ids[1]!), { status: "processed", errorCode: null, title: "台風Xがベトナム中部に上陸", language: "ja" });
        assert.equal((await articleState(pool, ids[2]!)).title, "Typhoon X hits central Vietnam");
        const sources = await count(
          pool,
          `SELECT COUNT(DISTINCT a.source_id) FROM event_articles ea JOIN articles a ON a.id = ea.article_id`,
        );
        assert.equal(sources, 3);
      });
    });

    await t.test("Test 3 — different real-world events stay separate", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const ai = h.oracle();
        const processor = h.processor(ai);
        const storm = await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ Việt Nam", language: "vi", publishedAt: T(9), story: "typhoon" });
        const policy = await h.addArticle({ source: h.sources.nhk, title: "Nhật Bản công bố chính sách kinh tế mới", language: "vi", publishedAt: T(10), story: "economy" });
        await processor.process(storm);
        const result = await processor.process(policy);

        assert.equal(result.status === "processed" && result.decision, "new_event");
        assert.equal(ai.callsFor("event-clustering").length, 1, "the AI judge saw the candidate");
        assert.notEqual((await eventOf(pool, storm))!.eventId, (await eventOf(pool, policy))!.eventId);
        assert.equal((await eventOf(pool, policy))!.method, "ai_new_event");
        assert.equal(await count(pool, "SELECT COUNT(*) FROM events"), 2);
      });
    });

    await t.test("Test 4 — uncertain never forces a merge and keeps the Article", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const processor = h.processor(h.oracle());
        const remarks = await h.addArticle({ source: h.sources.vnexpress, title: "Một quan chức phát biểu về kinh tế", language: "vi", publishedAt: T(9), story: "officialRemarks" });
        const report = await h.addArticle({ source: h.sources.vtv, title: "Một báo cáo khác nói về kinh tế", language: "vi", publishedAt: T(9, 30), story: "officialRemarks" });
        h.uncertainArticles.add(report);
        h.storyOf.set(report, "otherReport");

        await processor.process(remarks);
        const result = await processor.process(report);
        assert.equal(result.status === "processed" && result.decision, "uncertain");
        const association = await eventOf(pool, report);
        assert.equal(association?.method, "ai_uncertain");
        assert.notEqual(association?.eventId, (await eventOf(pool, remarks))!.eventId);
        assert.equal((await articleState(pool, report)).status, "processed");
      });
    });

    await t.test("Test 5 — Vietnamese title and 2–4 sentence summary are persisted with AI metadata", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const processor = h.processor(h.oracle());
        const id = await h.addArticle({ source: h.sources.nhk, title: "Typhoon X hits central Vietnam", language: "en", publishedAt: T(9), story: "typhoon" });
        await processor.process(id);
        const event = (
          await pool.query<{ titleVi: string; summaryVi: string; promptVersion: string; provider: string; model: string; processingStatus: string }>(
            `SELECT title_vi AS "titleVi", summary_vi AS "summaryVi", prompt_version AS "promptVersion", provider, model,
                    processing_status AS "processingStatus" FROM events`,
          )
        ).rows[0]!;
        assert.equal(event.titleVi, STORY_TEXT.typhoon.titleVi);
        const sentences = countSentences(event.summaryVi);
        assert.ok(sentences >= 2 && sentences <= 4, `summary has ${sentences} sentences`);
        assert.deepEqual([event.promptVersion, event.provider, event.model, event.processingStatus], [
          "event-summary-v2",
          "fake",
          "fake-model-v1",
          "processed",
        ]);
        assert.equal((await articleState(pool, id)).title, "Typhoon X hits central Vietnam", "original title untouched");
      });
    });

    await t.test("Test 6 — invalid AI output is rejected safely and never overwrites a valid Event", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const good = h.processor(h.oracle());
        const first = await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ", language: "vi", publishedAt: T(9), story: "typhoon" });
        await good.process(first);
        const eventId = (await eventOf(pool, first))!.eventId;

        // Invented event id → bounded retry (2 attempts) → failed, nothing persisted.
        const inventing = h.oracle({
          cluster: () => ({ decision: "merge", eventId: "11111111-1111-4111-8111-111111111111", articleIds: [], reason: "x" }),
        });
        const second = await h.addArticle({ source: h.sources.vnexpress, title: "Bão X gây mưa lớn", language: "vi", publishedAt: T(9, 20), story: "typhoon" });
        const rejected = await h.processor(inventing).process(second);
        assert.deepEqual(rejected, { status: "failed", errorCode: "AI_INVALID_OUTPUT" });
        assert.equal(inventing.callsFor("event-clustering").length, 2);
        assert.equal(await eventOf(pool, second), null);
        assert.equal((await articleState(pool, second)).status, "failed");

        // Valid merge but English/ungrounded summary → existing Event content untouched.
        const englishSummary = h.oracle({
          summarize: (request) => ({
            titleVi: "Typhoon X update",
            summaryVi: "The storm caused heavy rain. Thousands were evacuated.",
            evidenceArticleIds: readPromptPayload<{ articles: Array<{ id: string }> }>(request).articles.map((entry) => entry.id),
          }),
        });
        const third = await h.addArticle({ source: h.sources.nhk, title: "台風Xが上陸", language: "ja", publishedAt: T(9, 40), story: "typhoon" });
        const badSummary = await h.processor(englishSummary).process(third);
        assert.deepEqual(badSummary, { status: "failed", errorCode: "AI_INVALID_OUTPUT" });
        const event = (await pool.query<{ titleVi: string; summaryVi: string }>(
          `SELECT title_vi AS "titleVi", summary_vi AS "summaryVi" FROM events WHERE id = $1`,
          [eventId],
        )).rows[0]!;
        assert.deepEqual(event, STORY_TEXT.typhoon);
        assert.equal(await eventOf(pool, third), null, "no half-applied association");
        assert.equal(await count(pool, "SELECT COUNT(*) FROM events"), 1);

        const failedAttempts = await count(
          pool,
          `SELECT COUNT(*) FROM processing_attempts WHERE entity_id = $1 AND status = 'failed' AND error_code = 'AI_INVALID_OUTPUT'`,
          [second],
        );
        assert.equal(failedAttempts, 2);
      });
    });

    await t.test("Test 7 — provider failure keeps the Article, records attempts, and is retryable", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const outage = h.oracle({
          summarize: () => {
            throw new AIProviderError("AI_PROVIDER_UNAVAILABLE", "The AI provider is temporarily unavailable.");
          },
        });
        const id = await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ", language: "vi", publishedAt: T(9), story: "typhoon" });
        const failed = await h.processor(outage).process(id);
        assert.deepEqual(failed, { status: "failed", errorCode: "AI_PROVIDER_UNAVAILABLE" });
        assert.equal(outage.callsFor("event-summary").length, 3, "bounded transient retries");
        assert.deepEqual(await articleState(pool, id), { status: "failed", errorCode: "AI_PROVIDER_UNAVAILABLE", title: "Bão X đổ bộ", language: "vi" });
        const attempts = await pool.query<{ attemptNumber: number; status: string }>(
          `SELECT attempt_number AS "attemptNumber", status FROM processing_attempts WHERE entity_id = $1 ORDER BY attempt_number`,
          [id],
        );
        assert.deepEqual(attempts.rows.map((row) => row.attemptNumber), [1, 2, 3]);

        // Missing key: real adapter fails fast without network, Article preserved.
        const unconfigured = new GeminiProvider({ apiKey: undefined, model: "gemini-test" });
        const noKey = await h.processor(unconfigured).process(id);
        assert.deepEqual(noKey, { status: "failed", errorCode: "AI_NOT_CONFIGURED" });

        // Retry through the API service, then a healthy provider processes it.
        const enqueued: string[] = [];
        const service = new DefaultEventService(new PostgresEventReadStore(pool), async (articleId) => {
          enqueued.push(articleId);
          return `job-${articleId}`;
        });
        assert.deepEqual(await service.retryArticle(h.userId, id), { jobId: `job-${id}`, status: "queued" });
        assert.deepEqual(enqueued, [id]);
        const recovered = await h.processor(h.oracle()).process(id);
        assert.equal(recovered.status, "processed");
        assert.equal((await articleState(pool, id)).errorCode, null);
        await assert.rejects(service.retryArticle(h.userId, id), (error: unknown) => (error as { code?: string }).code === "CONFLICT");
      });
    });

    await t.test("Test 8 — duplicate/concurrent jobs and exact duplicates never create duplicate Events", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const ai = h.oracle();
        const processor = h.processor(ai);
        const id = await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ", language: "vi", publishedAt: T(9), story: "typhoon" });

        const [left, right] = await Promise.all([processor.process(id), processor.process(id)]);
        assert.deepEqual([left.status, right.status].sort(), ["processed", "skipped"]);
        assert.deepEqual(await processor.process(id), { status: "skipped", reason: "already_processed" });
        assert.equal(await count(pool, "SELECT COUNT(*) FROM events"), 1);
        assert.equal(await count(pool, "SELECT COUNT(*) FROM event_articles WHERE article_id = $1", [id]), 1);
        assert.equal(ai.callsFor("event-summary").length, 1, "AI is not called again for a processed Article");

        // Same canonical URL collected by another Source: joins the Event without any AI call.
        const canonicalUrl = (await pool.query<{ url: string }>(`SELECT canonical_url AS url FROM articles WHERE id = $1`, [id])).rows[0]!.url;
        const duplicate = await h.addArticle({ source: h.sources.vnexpress, title: "Bão X đổ bộ", language: "vi", publishedAt: T(9), story: "typhoon", canonicalUrl });
        const callsBefore = ai.calls.length;
        const result = await processor.process(duplicate);
        assert.equal(result.status === "processed" && result.decision, "exact_duplicate");
        assert.equal(ai.calls.length, callsBefore);
        assert.equal((await eventOf(pool, duplicate))!.method, "exact_duplicate");

        // Database remains the final guard: one Article → at most one Event.
        const otherEvent = await h.repositories.events.create({
          userId: h.userId,
          titleVi: "Sự kiện khác",
          status: "active",
          processingStatus: "processed",
          firstSeenAt: T(9),
          lastSeenAt: T(9),
        });
        await assert.rejects(
          h.repositories.eventArticles.create({ eventId: otherEvent.id, articleId: id, associationMethod: "manual" }),
          (error: unknown) => (error as { code?: string }).code === "CONFLICT",
        );
      });
    });

    await t.test("outbox → pg-boss process-article worker → Event (real queue)", async () => {
      await withIsolatedSchema(async (pool, schema) => {
        const h = await createHarness(pool);
        const queue = new PostgresJobQueue(databaseUrl!, () => undefined, schema);
        const dispatcher = new OutboxDispatcher(pool, {
          [ARTICLE_CREATED_EVENT]: async (payload) => {
            const jobId = await enqueueArticleProcessing(queue, articleIdFromPayload(payload));
            if (!jobId) throw new Error("not queued");
          },
        });
        try {
          await queue.start();
          await registerArticleProcessingWorker(queue, h.processor(h.oracle()));
          const a = await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ", language: "vi", publishedAt: T(9), story: "typhoon" });
          const b = await h.addArticle({ source: h.sources.cnn, title: "Typhoon X hits Vietnam", language: "en", publishedAt: T(9, 30), story: "typhoon" });

          assert.equal(await dispatcher.dispatchOnce(), 2);
          assert.equal(await dispatcher.dispatchOnce(), 0, "dispatched rows are not re-sent");
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            if ((await eventOf(pool, a)) && (await eventOf(pool, b))) break;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          const eventA = await eventOf(pool, a);
          const eventB = await eventOf(pool, b);
          assert.ok(eventA && eventB, "worker processed both Articles");
          assert.equal(eventA.eventId, eventB.eventId);
          assert.equal(await count(pool, "SELECT COUNT(*) FROM outbox_events WHERE status = 'dispatched'"), 2);
        } finally {
          await queue.stop();
        }
      });
    });

    await t.test("Event API: list, search, JST date filter, source filter, detail, ownership, CSRF", async () => {
      await withIsolatedSchema(async (pool) => {
        const store = createAuthStore(pool);
        const email = `phase5-api-${randomBytes(5).toString("hex")}@example.com`;
        const password = "phase5-api-test-password";
        const admin = await new AuthService(store).provisionAdmin(email, password);
        const h = await createHarness(pool, admin.user.id);
        const processor = h.processor(h.oracle());

        const storm = await h.addArticle({ source: h.sources.vtv, title: "Bão X đổ bộ miền Trung", language: "vi", publishedAt: T(9), story: "typhoon" });
        const stormEn = await h.addArticle({ source: h.sources.cnn, title: "Typhoon X hits central Vietnam", language: "en", publishedAt: T(10, 30), story: "typhoon" });
        // 16:30 UTC on 11/11 = 01:30 JST on 12/11.
        const policy = await h.addArticle({ source: h.sources.nhk, title: "日本政府、新たな経済対策", language: "ja", publishedAt: T(16, 30), story: "economy" });
        for (const id of [storm, stormEn, policy]) await processor.process(id);
        const stormEventId = (await eventOf(pool, storm))!.eventId;
        const policyEventId = (await eventOf(pool, policy))!.eventId;
        await h.repositories.sources.softDelete(h.sources.cnn.id, h.userId);

        const app = buildApp({ authStore: store, eventService: new DefaultEventService(new PostgresEventReadStore(pool), async () => "job-1") });
        try {
          const csrf = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token as string;
          const login = await app.inject({
            method: "POST",
            url: "/api/v1/auth/login",
            payload: { email, password },
            headers: { "x-csrf-token": csrf, cookie: `aidnd_csrf=${csrf}` },
          });
          const session = login.cookies.find((cookie) => cookie.name === "aidnd_session")!.value;
          const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie: `aidnd_session=${session}` } });

          assert.equal((await app.inject({ method: "GET", url: "/api/v1/events" })).statusCode, 401);

          const all = (await get("/api/v1/events")).json();
          assert.equal(all.total, 2);
          assert.deepEqual(all.items.map((item: { id: string }) => item.id), [policyEventId, stormEventId], "latest first");
          const stormItem = all.items[1];
          assert.equal(stormItem.articleCount, 2);
          assert.deepEqual(stormItem.sources.map((source: { name: string }) => source.name), ["CNN", "VTV"], "deleted source history kept");
          assert.equal(stormItem.titleVi, STORY_TEXT.typhoon.titleVi);
          assert.ok(!("model" in stormItem) && !("promptVersion" in stormItem) && !("confidence" in stormItem));

          const byEventTitle = (await get(`/api/v1/events?search=${encodeURIComponent("chính sách")}`)).json();
          assert.deepEqual(byEventTitle.items.map((item: { id: string }) => item.id), [policyEventId]);
          const byArticleTitle = (await get(`/api/v1/events?search=${encodeURIComponent("typhoon x")}`)).json();
          assert.deepEqual(byArticleTitle.items.map((item: { id: string }) => item.id), [stormEventId]);
          const bySourceName = (await get("/api/v1/events?search=nhk")).json();
          assert.deepEqual(bySourceName.items.map((item: { id: string }) => item.id), [policyEventId]);
          assert.equal((await get("/api/v1/events?search=%25")).json().total, 0, "LIKE wildcards are escaped");

          assert.deepEqual((await get("/api/v1/events?date=2026-11-11")).json().items.map((item: { id: string }) => item.id), [stormEventId]);
          assert.deepEqual((await get("/api/v1/events?date=2026-11-12")).json().items.map((item: { id: string }) => item.id), [policyEventId]);
          assert.deepEqual(
            (await get(`/api/v1/events?sourceId=${h.sources.vtv.id}`)).json().items.map((item: { id: string }) => item.id),
            [stormEventId],
          );
          const paged = (await get("/api/v1/events?page=2&pageSize=1")).json();
          assert.deepEqual([paged.total, paged.items.length, paged.items[0].id], [2, 1, stormEventId]);
          assert.equal((await get("/api/v1/events?date=11-11-2026")).statusCode, 400);
          assert.equal((await get("/api/v1/events?pageSize=500")).statusCode, 400);

          const detail = await get(`/api/v1/events/${stormEventId}`);
          assert.equal(detail.statusCode, 200);
          const body = detail.json();
          assert.equal(body.summaryVi, STORY_TEXT.typhoon.summaryVi);
          assert.deepEqual(body.articles.map((entry: { originalTitle: string }) => entry.originalTitle), [
            "Typhoon X hits central Vietnam",
            "Bão X đổ bộ miền Trung",
          ]);
          assert.equal(body.articles[1].publishedDateJst, "2026-11-11");
          assert.ok(body.articles.every((entry: { originalUrl: string }) => entry.originalUrl.startsWith("https://")));
          assert.equal((await get("/api/v1/events/not-a-uuid")).statusCode, 404);

          const stranger = await createHarness(pool);
          const strangerArticle = await stranger.addArticle({ source: stranger.sources.vtv, title: "Tin khác", language: "vi", publishedAt: T(9), story: "economy" });
          await stranger.processor(stranger.oracle()).process(strangerArticle);
          const strangerEvent = (await eventOf(pool, strangerArticle))!.eventId;
          assert.equal((await get(`/api/v1/events/${strangerEvent}`)).statusCode, 404, "other users' Events are hidden");
          assert.equal((await get("/api/v1/events")).json().total, 2);

          const noCsrf = await app.inject({
            method: "POST",
            url: `/api/v1/articles/${storm}/retry`,
            headers: { cookie: `aidnd_session=${session}` },
          });
          assert.equal(noCsrf.statusCode, 403);
          const freshCsrf = (await app.inject({ method: "GET", url: "/api/v1/auth/csrf" })).json().token as string;
          const processed = await app.inject({
            method: "POST",
            url: `/api/v1/articles/${storm}/retry`,
            headers: { cookie: `aidnd_session=${session}; aidnd_csrf=${freshCsrf}`, "x-csrf-token": freshCsrf },
          });
          assert.equal(processed.statusCode, 409, "processed Articles are not re-run");
        } finally {
          await app.close();
        }
      });
    });
  },
);

test(
  "Phase 8 AI quality hardening with PostgreSQL and FakeAIProvider",
  { skip: databaseUrl ? false : "Set TEST_DATABASE_URL or DATABASE_URL to run PostgreSQL integration tests." },
  async (t) => {
    const dataset = loadEvalDataset();

    await t.test("missed-merge regression: a matching Event older than 50 more recent Events still reaches the AI", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const typhoonA = await h.addArticle({ source: h.sources.vnexpress, title: "Bão X đổ bộ miền Trung", language: "vi", publishedAt: T(1), story: "typhoon" });
        await h.processor(h.oracle()).process(typhoonA);

        // 60 newer, unrelated Events push the typhoon Event past recency position 50 (Phase 7: positions 50-78).
        const separate = h.processor(
          h.oracle({ cluster: (request) => ({ decision: "new_event", eventId: null, articleIds: [readPromptPayload<{ article: { id: string } }>(request).article.id], reason: "Different.", eventIdentity: { sameActors: false, sameAction: false, compatibleLocation: false, compatibleTime: true } }) }),
        );
        for (let index = 0; index < 60; index += 1) {
          const id = await h.addArticle({ source: h.sources.cnn, title: `Quarterly report ${index} on regional trade figures`, language: "en", publishedAt: T(2, index % 60), story: "otherReport" });
          await separate.process(id);
        }
        assert.equal(await count(pool, "SELECT COUNT(*) FROM events"), 61);
        assert.ok(DEFAULT_CANDIDATE_POOL_SIZE > 61);

        const ai = h.oracle();
        const typhoonB = await h.addArticle({ source: h.sources.vtv, title: "Bão X gây mưa lớn ở miền Trung", language: "vi", publishedAt: T(5), story: "typhoon" });
        const result = await h.processor(ai).process(typhoonB);
        assert.equal(result.status === "processed" && result.decision, "merge");
        assert.equal((await eventOf(pool, typhoonB))!.eventId, (await eventOf(pool, typhoonA))!.eventId);
        const offered = readPromptPayload<{ candidateEvents: Array<{ eventId: string }> }>(ai.callsFor("event-clustering")[0]!).candidateEvents;
        assert.ok(offered.length <= 8, "AI still sees at most AI_MAX_CANDIDATES");
        assert.ok(offered.some((candidate) => candidate.eventId === (result.status === "processed" ? result.eventId : "")));
      });
    });

    await t.test("false-merge regression (case-001): topic-only merge is persisted as a separate ai_uncertain Event", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const [threatFixture, aircraftFixture] = dataset.cases.find((entry) => entry.id === "case-001")!.articles;
        const threat = await h.addArticle({ source: h.sources.vnexpress, title: threatFixture!.title, excerpt: threatFixture!.excerpt ?? undefined, language: threatFixture!.language, publishedAt: threatFixture!.publishedAt, canonicalUrl: threatFixture!.url, story: "otherReport" });
        const aircraft = await h.addArticle({ source: h.sources.vtv, title: aircraftFixture!.title, excerpt: aircraftFixture!.excerpt ?? undefined, language: aircraftFixture!.language, publishedAt: aircraftFixture!.publishedAt, canonicalUrl: aircraftFixture!.url, story: "officialRemarks" });
        await h.processor(h.oracle()).process(threat);

        const phase7Like = h.oracle({
          cluster: (request) => {
            const payload = readPromptPayload<{ article: { id: string }; candidateEvents: Array<{ eventId: string; articles: Array<{ id: string }> }> }>(request);
            const candidate = payload.candidateEvents[0]!;
            return {
              decision: "merge",
              eventId: candidate.eventId,
              articleIds: [payload.article.id, candidate.articles[0]!.id],
              reason: "Both concern US bases and Iran.",
              eventIdentity: { sameActors: true, sameAction: false, compatibleLocation: false, compatibleTime: true },
            };
          },
        });
        const result = await h.processor(phase7Like).process(aircraft);
        assert.equal(result.status === "processed" && result.decision, "uncertain");
        assert.notEqual((await eventOf(pool, aircraft))!.eventId, (await eventOf(pool, threat))!.eventId);
        assert.equal((await eventOf(pool, aircraft))!.method, "ai_uncertain");
        assert.equal(await count(pool, "SELECT COUNT(*) FROM events"), 2);
        assert.equal(
          await count(pool, `SELECT COUNT(*) FROM processing_attempts WHERE entity_id = $1 AND operation = 'event-clustering' AND decision = 'uncertain' AND target_event_id IS NULL`, [aircraft]),
          1,
        );
      });
    });

    await t.test("filler summary is rejected and retried once; a second filler output fails the Article without losing it", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const filler = dataset.cases.find((entry) => entry.id === "case-008")!.phase7Observed!;
        let calls = 0;
        const flaky = h.oracle({
          summarize: (request) => {
            calls += 1;
            const ids = readPromptPayload<{ articles: Array<{ id: string }> }>(request).articles.map((entry) => entry.id);
            return calls === 1
              ? { titleVi: filler.titleVi, summaryVi: filler.summaryVi, evidenceArticleIds: ids }
              : { ...STORY_TEXT.economy, evidenceArticleIds: ids };
          },
        });
        const id = await h.addArticle({ source: h.sources.vtv, title: "COP31 thúc đẩy hành động khí hậu", language: "vi", publishedAt: T(3), story: "economy" });
        assert.equal((await h.processor(flaky).process(id)).status, "processed");
        const attempts = await pool.query<{ status: string; errorCode: string | null }>(
          `SELECT status, error_code AS "errorCode" FROM processing_attempts WHERE entity_id = $1 AND operation = 'event-summary' ORDER BY created_at`,
          [id],
        );
        assert.deepEqual(attempts.rows.map((row) => [row.status, row.errorCode]), [["failed", "AI_INVALID_OUTPUT"], ["succeeded", null]]);
        assert.doesNotMatch((await pool.query<{ s: string }>(`SELECT summary_vi AS s FROM events`)).rows[0]!.s, /thu hút sự quan tâm/);

        const alwaysFiller = h.oracle({
          summarize: (request) => ({ titleVi: filler.titleVi, summaryVi: filler.summaryVi, evidenceArticleIds: readPromptPayload<{ articles: Array<{ id: string }> }>(request).articles.map((entry) => entry.id) }),
        });
        const second = await h.addArticle({ source: h.sources.vnexpress, title: "Hội nghị COP31 khai mạc", language: "vi", publishedAt: T(23), story: "otherReport" });
        const failed = await h.processor(alwaysFiller).process(second);
        assert.deepEqual(failed, { status: "failed", errorCode: "AI_INVALID_OUTPUT" });
        assert.equal((await articleState(pool, second)).title, "Hội nghị COP31 khai mạc", "Article preserved for retry");
        assert.equal(await eventOf(pool, second), null);
      });
    });

    await t.test("language backfill fills only missing values, never touches content, and is safe to rerun", async () => {
      await withIsolatedSchema(async (pool) => {
        const h = await createHarness(pool);
        const create = (title: string, excerpt: string | null, originalLanguage: string | null) =>
          h.repositories.articles.create({
            sourceId: h.sources.vtv.id,
            originalUrl: `https://vtv.example.com/${randomBytes(4).toString("hex")}`,
            canonicalUrl: null,
            originalTitle: title,
            originalLanguage,
            originalExcerpt: excerpt,
            originalContent: excerpt,
            publishedAt: T(1),
          });
        const vi = await create("Nga, Mỹ và Ukraine nối lại đàm phán ba bên tại UAE", null, null);
        const ja = await create("米国防長官ら 墓地で衛兵から叱責", null, null);
        const en = await create("Hegseth awards medal to war memorial guard", "Specialist Thomas Iglesias had shouted at the group.", null);
        const undetermined = await create("中国经济增长放缓", null, null);
        const preset = await create("Bão số 3 đổ bộ", null, "xx");

        const snapshot = async () =>
          (await pool.query(`SELECT id, original_title, original_excerpt, original_content, original_url, canonical_url, published_at, processing_status, updated_at FROM articles ORDER BY id`)).rows;
        const before = await snapshot();

        const dry = await backfillArticleLanguages(pool, { dryRun: true });
        assert.deepEqual([dry.scanned, dry.updated, dry.undetermined], [4, 0, 1]);
        assert.equal(await count(pool, "SELECT COUNT(*) FROM articles WHERE original_language IS NULL"), 4, "dry run writes nothing");

        const run = await backfillArticleLanguages(pool);
        assert.deepEqual([run.updated, run.undetermined, run.byLanguage], [3, 1, { vi: 1, ja: 1, en: 1 }]);
        const languageOf = async (id: string) => (await articleState(pool, id)).language;
        assert.deepEqual(
          [await languageOf(vi.id), await languageOf(ja.id), await languageOf(en.id), await languageOf(undetermined.id), await languageOf(preset.id)],
          ["vi", "ja", "en", null, "xx"],
        );
        assert.deepEqual(await snapshot(), before, "content, URLs, dates, and status unchanged");

        const rerun = await backfillArticleLanguages(pool);
        assert.deepEqual([rerun.scanned, rerun.updated], [1, 0]);
      });
    });
  },
);
