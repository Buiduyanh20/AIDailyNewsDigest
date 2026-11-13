import { buildApp } from "./app.js";
import { GeminiProvider } from "./ai/gemini-provider.js";
import { createAuthStore } from "./db/auth-store.js";
import { createDatabasePool } from "./db/pool.js";
import { environment } from "./config/env.js";
import { ArticleProcessor, consoleProcessingLogger } from "./events/processor.js";
import { DefaultEventService } from "./events/service.js";
import { PostgresEventProcessingStore, PostgresEventReadStore } from "./events/store.js";
import { enqueueArticleProcessing, registerArticleProcessingWorker } from "./events/worker.js";
import {
  ARTICLE_CREATED_EVENT,
  ARTICLE_REPROCESS_EVENT,
  OutboxDispatcher,
  articleIdFromPayload,
} from "./outbox/dispatcher.js";
import { PostgresJobQueue } from "./queue/job-queue.js";
import { createRuntimeSourceService } from "./sources/service.js";
import { registerSourceCollectionWorker, SOURCE_COLLECTION_QUEUE } from "./sources/worker.js";
import { ResendEmailProvider } from "./email/resend-provider.js";
import { DefaultDigestApi, DigestDeliveryService, DigestGenerationService } from "./digest/service.js";
import { DIGEST_DELIVER_EVENT, DIGEST_READY_EVENT, PostgresDigestStore } from "./digest/store.js";
import {
  enqueueDigestDelivery,
  registerDigestJobs,
  runCronTick,
  startDigestScheduler,
  stopDigestScheduler,
  type DigestJobDeps,
} from "./digest/jobs.js";
import { fileURLToPath } from "node:url";

const REQUIRED_MIGRATION = "004_phase6_digest";

const pool = createDatabasePool();
const queue = new PostgresJobQueue(environment.databaseUrl ?? "");
const sourceService = createRuntimeSourceService({
  pool,
  enqueueCollection: (sourceId) => queue.enqueue(SOURCE_COLLECTION_QUEUE, { sourceId }, { retryLimit: 0 }),
});

// AI provider: the key stays server-side inside the adapter.
const aiProvider = new GeminiProvider({
  apiKey: environment.ai.geminiApiKey,
  model: environment.ai.geminiModel,
  timeoutMs: environment.ai.requestTimeoutMs,
});
const articleProcessor = new ArticleProcessor({
  store: new PostgresEventProcessingStore(pool),
  ai: aiProvider,
  config: {
    candidateWindowHours: environment.ai.candidateWindowHours,
    maxCandidates: environment.ai.maxCandidates,
  },
  logger: consoleProcessingLogger,
});
const eventService = new DefaultEventService(new PostgresEventReadStore(pool), (articleId) =>
  enqueueArticleProcessing(queue, articleId),
);
const enqueueFromOutbox = async (payload: Parameters<typeof articleIdFromPayload>[0]): Promise<void> => {
  const jobId = await enqueueArticleProcessing(queue, articleIdFromPayload(payload));
  if (!jobId) throw new Error("process-article job was not created.");
};
// Phase 6: Daily Digest + Resend. Keys stay inside the adapter; the recipient comes from user_settings.
const digestStore = new PostgresDigestStore(pool);
const emailProvider = new ResendEmailProvider({
  apiKey: environment.email.provider === "resend" ? environment.email.resendApiKey : undefined,
  timeoutMs: environment.email.requestTimeoutMs,
});
const digestJobDeps: DigestJobDeps = {
  queue,
  store: digestStore,
  generation: new DigestGenerationService(digestStore, consoleProcessingLogger),
  delivery: new DigestDeliveryService({ store: digestStore, email: emailProvider, from: environment.email.from, logger: consoleProcessingLogger }),
  logger: consoleProcessingLogger,
  enqueueCollectAll: async () => {
    const sources = await pool.query<{ id: string }>(
      "SELECT id FROM sources WHERE enabled AND deleted_at IS NULL AND rss_url IS NOT NULL ORDER BY id",
    );
    for (const source of sources.rows) {
      await queue.enqueue(SOURCE_COLLECTION_QUEUE, { sourceId: source.id }, { retryLimit: 0 });
    }
    return sources.rowCount ?? 0;
  },
};
const enqueueDeliveryFromOutbox = async (payload: Parameters<typeof articleIdFromPayload>[0]): Promise<void> => {
  const digestId = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.digestId : undefined;
  if (typeof digestId !== "string") throw new Error("Outbox payload does not contain a digestId.");
  if (!(await enqueueDigestDelivery(queue, digestId))) throw new Error("deliver-digest job was not created.");
};

const outboxDispatcher = new OutboxDispatcher(
  pool,
  {
    [ARTICLE_CREATED_EVENT]: enqueueFromOutbox,
    [ARTICLE_REPROCESS_EVENT]: enqueueFromOutbox,
    [DIGEST_READY_EVENT]: enqueueDeliveryFromOutbox,
    [DIGEST_DELIVER_EVENT]: enqueueDeliveryFromOutbox,
  },
  { logger: consoleProcessingLogger },
);

const app = buildApp({
  authStore: createAuthStore(pool),
  sourceService,
  eventService,
  digestApi: new DefaultDigestApi(digestStore),
  resendWebhook: {
    secret: environment.email.resendWebhookSecret,
    apply: (input) => digestStore.applyDeliveryWebhook(input),
  },
  // Phase 9: Cron-job.org wakes the (possibly sleeping) service and enqueues the due JST work.
  cronTrigger: {
    token: environment.digest.cronTriggerToken,
    trigger: () => runCronTick(digestJobDeps),
  },
  // Single container: serve the built React app in production (apps/web/dist next to apps/server).
  webDistDir:
    environment.webDistDir ?? (environment.nodeEnv === "production" ? fileURLToPath(new URL("../../web/dist/", import.meta.url)) : undefined),
  readinessCheck: async () => {
    await pool.query("SELECT 1");
    if (!queue.isReady) {
      return false;
    }

    const migrationTable = await pool.query<{ migrationTableExists: boolean }>(
      "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS \"migrationTableExists\"",
    );
    if (!migrationTable.rows[0]?.migrationTableExists) {
      return false;
    }

    const migration = await pool.query<{ version: string }>("SELECT version FROM schema_migrations WHERE version = $1", [
      REQUIRED_MIGRATION,
    ]);
    return migration.rowCount === 1;
  },
});

app.addHook("onClose", async () => {
  try {
    await outboxDispatcher.stop();
    await queue.stop();
  } finally {
    await pool.end();
  }
});

/** Render sends SIGTERM and force-kills after ~30 s; finish well before that. */
const SHUTDOWN_DEADLINE_MS = 28_000;

let closing = false;
const close = (signal: NodeJS.Signals): void => {
  if (closing) {
    return;
  }
  closing = true;
  consoleProcessingLogger.info({ signal }, "shutdown started: closing HTTP server, outbox, pg-boss, and pool");
  // Stops accepting connections, waits for in-flight requests, then the onClose hook stops the
  // outbox dispatcher, lets active pg-boss jobs finish (bounded), and ends the pool.
  setTimeout(() => {
    consoleProcessingLogger.error({ signal }, "shutdown deadline exceeded; exiting");
    process.exit(1);
  }, SHUTDOWN_DEADLINE_MS).unref();
  void app
    .close()
    .then(() => {
      consoleProcessingLogger.info({ signal }, "shutdown complete");
      process.exit(process.exitCode ?? 0);
    })
    .catch((error: unknown) => {
      consoleProcessingLogger.error({ signal, errorName: error instanceof Error ? error.name : "UnknownError" }, "failed to shut down cleanly");
      process.exit(1);
    });
};

process.once("SIGINT", close);
process.once("SIGTERM", close);

try {
  await queue.start();
  await registerSourceCollectionWorker(queue, sourceService);
  await registerArticleProcessingWorker(queue, articleProcessor);
  await registerDigestJobs(digestJobDeps);
  outboxDispatcher.start();
  if (environment.digest.schedulerEnabled) {
    await startDigestScheduler(digestJobDeps);
  } else {
    await stopDigestScheduler(digestJobDeps);
    consoleProcessingLogger.warn({}, "DIGEST_SCHEDULER_ENABLED=false; daily digest schedule removed");
  }
  if (environment.email.provider !== "resend" || !environment.email.resendApiKey || !environment.email.from) {
    consoleProcessingLogger.warn({ provider: "resend" }, "Email is not fully configured (EMAIL_PROVIDER/RESEND_API_KEY/EMAIL_FROM); digest delivery will fail");
  }
  if (!environment.ai.geminiApiKey) {
    consoleProcessingLogger.warn({ provider: aiProvider.name }, "GEMINI_API_KEY is not set; AI processing will fail with AI_NOT_CONFIGURED");
  }
  if (!environment.digest.cronTriggerToken) {
    consoleProcessingLogger.warn({}, "CRON_TRIGGER_TOKEN is not set; the external cron trigger endpoint is disabled");
  }
  await app.listen({ host: "0.0.0.0", port: environment.port });
  consoleProcessingLogger.info({ port: environment.port, nodeEnv: environment.nodeEnv }, "server listening");
} catch (error) {
  consoleProcessingLogger.error(
    { errorName: error instanceof Error ? error.name : "UnknownError", message: error instanceof Error ? error.message : null },
    "failed to start server",
  );
  await app.close();
  process.exitCode = 1;
}
