import { BUSINESS_TIMEZONE, catchUpModeAt, cronTickPlan, digestDateFor, digestTimeline, type DigestBuildMode } from "@aidnd/domain";

import { ValidationError } from "../errors/index.js";
import type { ProcessingLogger } from "../events/processor.js";
import type { JobQueue } from "../queue/job-queue.js";
import type { DigestDeliveryService, DigestGenerationService } from "./service.js";
import type { PostgresDigestStore } from "./store.js";

export const GENERATE_DIGEST_QUEUE = "generate-digest";
export const DELIVER_DIGEST_QUEUE = "deliver-digest";

/** Cron ticks, evaluated by pg-boss in Asia/Tokyo regardless of the host timezone. */
export const DIGEST_CRON = {
  collect: { queue: "schedule-collect-sources", cron: "30 5 * * *" }, // 05:30 final collection window
  draft: { queue: "schedule-digest-draft", cron: "0,30 6 * * *" }, // 06:00 generate, 06:30 candidate snapshot
  finalize: { queue: "schedule-digest-finalize", cron: "45 6 * * *" }, // 06:45 validation + immutable cutoff
} as const;
// 07:00 delivery: finalize writes a digest.ready outbox row with available_at = 07:00 JST.

type GenerateJob = { userId: string; localDate: string; mode: DigestBuildMode };
type DeliverJob = { digestId: string };

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DigestJobDeps = {
  queue: JobQueue;
  store: PostgresDigestStore;
  generation: DigestGenerationService;
  delivery: DigestDeliveryService;
  enqueueCollectAll: () => Promise<number>;
  logger: ProcessingLogger;
  now?: () => Date;
};

export function enqueueDigestDelivery(queue: JobQueue, digestId: string): Promise<string | null> {
  // Duplicates are safe: delivery claims atomically and skips sent Digests. Provider
  // errors are handled inside the service; pg-boss retries cover unexpected crashes only.
  return queue.enqueue(DELIVER_DIGEST_QUEUE, { digestId }, { retryLimit: 3, retryDelay: 60, retryBackoff: true });
}

/** Enqueues generate-digest for every active user for yesterday's JST date. */
export async function fanOutGeneration(deps: DigestJobDeps, mode: DigestBuildMode): Promise<string> {
  const localDate = digestDateFor((deps.now ?? (() => new Date()))());
  for (const userId of await deps.store.listDigestUserIds()) {
    await deps.queue.enqueue(GENERATE_DIGEST_QUEUE, { userId, localDate, mode }, { retryLimit: 2, retryDelay: 30 });
  }
  deps.logger.info({ localDate, mode }, "digest generation fan-out queued");
  return localDate;
}

export async function registerDigestJobs(deps: DigestJobDeps): Promise<void> {
  await deps.queue.work<GenerateJob>(GENERATE_DIGEST_QUEUE, async (data) => {
    if (!data || typeof data.userId !== "string" || !LOCAL_DATE.test(data.localDate ?? "") || (data.mode !== "draft" && data.mode !== "finalize")) {
      throw new ValidationError("The generate-digest job payload is invalid.");
    }
    const result = await deps.generation.generate(data);
    // Recovery: a frozen, unsent Digest past its 07:00 JST send time gets its delivery re-enqueued
    // (e.g. the earlier deliver-digest job crashed). Delivery is idempotent: at most one email.
    const now = (deps.now ?? (() => new Date()))();
    if (
      data.mode === "finalize" &&
      !result.rebuilt &&
      (result.digest.status === "ready" || result.digest.status === "sending") &&
      now.getTime() >= digestTimeline(data.localDate).sendAt.getTime()
    ) {
      await enqueueDigestDelivery(deps.queue, result.digest.id);
      deps.logger.warn({ digestId: result.digest.id, localDate: data.localDate }, "unsent frozen digest found; delivery re-enqueued");
    }
  });

  await deps.queue.work<DeliverJob>(DELIVER_DIGEST_QUEUE, async (data) => {
    if (!data || typeof data.digestId !== "string") {
      throw new ValidationError("The deliver-digest job payload is invalid.");
    }
    await deps.delivery.deliver(data.digestId);
  });

  await deps.queue.work(DIGEST_CRON.collect.queue, async () => {
    const count = await deps.enqueueCollectAll();
    deps.logger.info({ sources: count }, "05:30 JST collection queued");
  });
  await deps.queue.work(DIGEST_CRON.draft.queue, async () => {
    await fanOutGeneration(deps, "draft");
  });
  await deps.queue.work(DIGEST_CRON.finalize.queue, async () => {
    await fanOutGeneration(deps, "finalize");
  });
}

export type CronTickResult = {
  localDate: string;
  operations: Array<{ operation: "collect-sources" | "digest-draft" | "digest-finalize"; jobId: string | null }>;
};

/**
 * Phase 9 external trigger (Cron-job.org → POST /api/v1/internal/cron/daily-digest).
 * Only enqueues the tick jobs the in-process pg-boss cron would have produced —
 * the same workers and business logic run them — and returns immediately.
 *
 * Retried/duplicate calls are coalesced by pg-boss throttling (collection: one per
 * JST morning; generation: one per mode and 5-minute slot); jobId is null when a
 * call was coalesced. Beyond that, the Digest/EmailDelivery unique constraints and
 * the atomic delivery claim guarantee at most one Digest and one email per date.
 */
export async function runCronTick(deps: Pick<DigestJobDeps, "queue" | "logger" | "now">): Promise<CronTickResult> {
  const plan = cronTickPlan((deps.now ?? (() => new Date()))());
  const operations: CronTickResult["operations"] = [];
  if (plan.collect) {
    const jobId = await deps.queue.enqueue(DIGEST_CRON.collect.queue, {}, {
      singletonKey: `cron-collect:${plan.today}`,
      // pg-boss throttle slots are UTC-epoch aligned and capped at its 12 h archive interval;
      // 6 h slots (03:00–09:00 JST) fully contain the 05:30–06:45 JST collection window.
      singletonSeconds: 6 * 60 * 60,
      retryLimit: 0,
    });
    operations.push({ operation: "collect-sources", jobId });
  }
  if (plan.mode) {
    const tick = plan.mode === "draft" ? DIGEST_CRON.draft : DIGEST_CRON.finalize;
    const jobId = await deps.queue.enqueue(tick.queue, {}, {
      singletonKey: `cron-${plan.mode}:${plan.digestDate}`,
      singletonSeconds: 5 * 60,
      retryLimit: 1,
    });
    operations.push({ operation: plan.mode === "draft" ? "digest-draft" : "digest-finalize", jobId });
  }
  deps.logger.info(
    { localDate: plan.digestDate, operations: operations.map((entry) => `${entry.operation}:${entry.jobId ? "queued" : "coalesced"}`) },
    "cron tick accepted",
  );
  return { localDate: plan.digestDate, operations };
}

/** Removes the persisted cron schedules (DIGEST_SCHEDULER_ENABLED=false must really stop the ticks). */
export async function stopDigestScheduler(deps: Pick<DigestJobDeps, "queue">): Promise<void> {
  for (const tick of Object.values(DIGEST_CRON)) {
    await deps.queue.unschedule(tick.queue);
  }
}

/**
 * Registers the Asia/Tokyo cron schedules (idempotent across restarts) and
 * catches up today's run if the server was down at 06:00/06:45 JST. Catch-up
 * is safe to repeat: generation is idempotent and sent Digests are frozen.
 */
export async function startDigestScheduler(deps: DigestJobDeps): Promise<void> {
  for (const tick of Object.values(DIGEST_CRON)) {
    await deps.queue.schedule(tick.queue, tick.cron, BUSINESS_TIMEZONE);
  }
  const mode = catchUpModeAt((deps.now ?? (() => new Date()))());
  if (mode) {
    const localDate = await fanOutGeneration(deps, mode);
    deps.logger.info({ localDate, mode }, "digest scheduler catch-up queued");
  }
}
