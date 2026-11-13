import type {
  DashboardSummary,
  DigestDetailResponse,
  DigestListResponse,
  DigestPreviewResponse,
  DigestSummary,
} from "@aidnd/contracts";
import {
  digestDisplayDate,
  digestIdempotencyKey,
  digestSubject,
  digestTimeline,
  isDeliveryAccepted,
  nextDigestSend,
  type DigestBuildMode,
} from "@aidnd/domain";
import { z } from "zod";

import { EmailProviderError, type EmailProvider } from "../email/provider.js";
import { NotFoundError } from "../errors/index.js";
import type { ProcessingLogger } from "../events/processor.js";
import { renderDigestEmail } from "./render.js";
import type { BuildDigestResult, DeliveryRecord, PostgresDigestStore } from "./store.js";

const uuid = z.string().uuid();

// ---------------------------------------------------------------------------
// Generation (generate-digest)
// ---------------------------------------------------------------------------

export class DigestGenerationService {
  constructor(
    private readonly store: PostgresDigestStore,
    private readonly logger: ProcessingLogger,
  ) {}

  /**
   * Idempotent: one Digest per (user, date). Draft runs rebuild the candidate
   * snapshot; finalize freezes it at the 06:45 JST cutoff. If finalizing fails,
   * an empty Digest is frozen instead (degraded) so 07:00 still sends one email.
   */
  async generate(input: { userId: string; localDate: string; mode: DigestBuildMode }): Promise<BuildDigestResult> {
    const { cutoffAt, sendAt } = digestTimeline(input.localDate);
    const log = { userId: input.userId, localDate: input.localDate, mode: input.mode };
    try {
      const result = await this.store.buildDigest({ ...input, cutoffAt, sendAt });
      this.logger.info({ ...log, digestId: result.digest.id, status: result.digest.status, rebuilt: result.rebuilt, eventCount: result.eventCount }, "generate-digest completed");
      return result;
    } catch (error) {
      if (input.mode !== "finalize") throw error;
      this.logger.error({ ...log, errorCode: (error as { code?: string }).code ?? "DIGEST_GENERATION_FAILED" }, "generate-digest failed; freezing degraded empty digest");
      const fallback = await this.store.buildDigest({ ...input, cutoffAt, sendAt, forceEmpty: true, failureCode: "DEGRADED_GENERATION" });
      this.logger.warn({ ...log, digestId: fallback.digest.id, errorCode: "DEGRADED_GENERATION" }, "operational alert: degraded digest generation");
      return fallback;
    }
  }
}

// ---------------------------------------------------------------------------
// Delivery (deliver-digest)
// ---------------------------------------------------------------------------

export type DeliveryOutcome =
  | { status: "skipped"; reason: "not_found" | "not_ready" | "already_sent" | "in_progress" }
  | { status: "sent"; providerMessageId: string }
  | { status: "retry_scheduled" | "unknown" | "failed"; errorCode: string };

export type DeliveryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; random?: () => number };

export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = { maxAttempts: 5, baseDelayMs: 60_000, maxDelayMs: 30 * 60_000 };

export class DigestDeliveryService {
  private readonly policy: DeliveryPolicy;

  constructor(
    private readonly deps: {
      store: PostgresDigestStore;
      email: EmailProvider;
      from: string | undefined;
      logger: ProcessingLogger;
      policy?: DeliveryPolicy;
    },
  ) {
    this.policy = deps.policy ?? DEFAULT_DELIVERY_POLICY;
  }

  /**
   * Sends the one email for a frozen Digest. No DB transaction is held during
   * the provider call. Retries reuse the same idempotency key, so an ambiguous
   * timeout followed by a retry cannot produce a second email.
   */
  async deliver(digestId: string): Promise<DeliveryOutcome> {
    const { store, email, logger } = this.deps;
    const digest = await store.getDigest(digestId);
    if (!digest) return { status: "skipped", reason: "not_found" };
    if (digest.status === "sent") return { status: "skipped", reason: "already_sent" };
    if (digest.status === "scheduled" || digest.status === "building") return { status: "skipped", reason: "not_ready" };
    const log = { digestId, userId: digest.userId, localDate: digest.localDate, provider: email.name };

    let delivery = await store.getDelivery(digestId);
    if (!delivery) {
      const recipient = await store.getRecipient(digest.userId);
      if (!this.deps.from || !recipient) {
        const errorCode = !this.deps.from ? "EMAIL_NOT_CONFIGURED" : "RECIPIENT_MISSING";
        await store.markDigestFailed(digestId, errorCode);
        logger.error({ ...log, errorCode }, "deliver-digest cannot create the email");
        return { status: "failed", errorCode };
      }
      const rendered = renderDigestEmail({ localDate: digest.localDate, events: await store.getSnapshotEvents(digestId) });
      delivery = await store.ensureDelivery({
        digestId,
        idempotencyKey: digestIdempotencyKey(digest.userId, digest.localDate),
        provider: email.name,
        recipientEmail: recipient,
        senderEmail: this.deps.from,
        subject: rendered.subject,
        htmlBody: rendered.html,
        textBody: rendered.text,
      });
    }

    if (isDeliveryAccepted(delivery.status)) {
      await store.markAccepted(delivery, delivery.provider ?? email.name, delivery.providerMessageId ?? "", delivery.status === "delivered");
      return { status: "skipped", reason: "already_sent" };
    }

    // Reconcile an ambiguous outcome before sending again.
    if (delivery.status === "unknown" && delivery.providerMessageId) {
      const reconciled = await email.getDeliveryStatus(delivery.providerMessageId).catch(() => null);
      if (reconciled === "accepted" || reconciled === "delivered") {
        const claimed = await store.claimDelivery(delivery.id);
        if (claimed) await store.markAccepted(claimed, email.name, delivery.providerMessageId, reconciled === "delivered");
        logger.info({ ...log, status: reconciled }, "deliver-digest reconciled: provider already accepted");
        return { status: "sent", providerMessageId: delivery.providerMessageId };
      }
    }

    const claimed = await store.claimDelivery(delivery.id);
    if (!claimed) return { status: "skipped", reason: "in_progress" };

    try {
      const result = await email.send({
        from: claimed.senderEmail,
        to: claimed.recipientEmail,
        subject: claimed.subject,
        html: claimed.htmlBody,
        text: claimed.textBody,
        idempotencyKey: claimed.idempotencyKey,
      });
      await store.markAccepted(claimed, email.name, result.providerMessageId);
      logger.info({ ...log, attempt: claimed.attemptCount, status: "accepted" }, "deliver-digest accepted by provider");
      return { status: "sent", providerMessageId: result.providerMessageId };
    } catch (error) {
      return this.handleFailure(claimed, error, log);
    }
  }

  private async handleFailure(claimed: DeliveryRecord, error: unknown, log: Record<string, unknown>): Promise<DeliveryOutcome> {
    const { store, logger } = this.deps;
    const providerError = error instanceof EmailProviderError ? error : null;
    const errorCode = providerError?.code ?? "EMAIL_SEND_FAILED";
    // Unexpected (non-provider) errors are treated as ambiguous: never assume "not sent".
    const kind = providerError?.kind ?? "ambiguous";
    const exhausted = claimed.attemptCount >= this.policy.maxAttempts;

    if (kind === "permanent") {
      await store.markFailure(claimed, { status: "failed", errorCode, final: true });
      logger.error({ ...log, attempt: claimed.attemptCount, errorCode, status: "failed" }, "deliver-digest permanent failure (not retried)");
      return { status: "failed", errorCode };
    }

    const status = kind === "ambiguous" ? "unknown" : "failed";
    await store.markFailure(claimed, { status, errorCode, final: exhausted });
    if (exhausted) {
      logger.error({ ...log, attempt: claimed.attemptCount, errorCode, status }, "deliver-digest retries exhausted");
      return { status: status === "unknown" ? "unknown" : "failed", errorCode };
    }

    const random = this.policy.random ?? Math.random;
    const exponential = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (claimed.attemptCount - 1));
    const delayMs = Math.max(Math.round(exponential / 2 + random() * (exponential / 2)), providerError?.options.retryAfterMs ?? 0);
    await store.scheduleDeliveryRetry(claimed.digestId, claimed.attemptCount + 1, delayMs);
    logger.warn({ ...log, attempt: claimed.attemptCount, errorCode, status, retryInMs: delayMs }, "deliver-digest will retry");
    return { status: kind === "ambiguous" ? "unknown" : "retry_scheduled", errorCode };
  }
}

// ---------------------------------------------------------------------------
// Read API (Digest list/detail/preview, Dashboard)
// ---------------------------------------------------------------------------

export interface DigestApi {
  list(userId: string, page: number, pageSize: number): Promise<DigestListResponse>;
  detail(userId: string, digestId: string): Promise<DigestDetailResponse>;
  preview(userId: string, digestId: string): Promise<DigestPreviewResponse>;
  dashboard(userId: string, now?: Date): Promise<DashboardSummary>;
}

export class DefaultDigestApi implements DigestApi {
  constructor(private readonly store: PostgresDigestStore) {}

  async list(userId: string, page: number, pageSize: number): Promise<DigestListResponse> {
    const { items, total } = await this.store.listDigests(userId, page, pageSize);
    return { items, page, pageSize, total };
  }

  private async load(userId: string, digestId: string) {
    if (!uuid.safeParse(digestId).success) throw new NotFoundError("The digest was not found.");
    const digest = await this.store.getDigest(digestId, userId);
    if (!digest) throw new NotFoundError("The digest was not found.");
    const [events, delivery] = await Promise.all([this.store.getSnapshotEvents(digestId), this.store.getDelivery(digestId)]);
    const summary: DigestSummary = {
      id: digest.id,
      localDate: digest.localDate,
      status: digest.status,
      subject: digestSubject(digest.localDate),
      eventCount: events.length,
      isEmpty: events.length === 0,
      builtAt: digest.builtAt,
      sentAt: digest.sentAt,
      deliveryStatus: delivery?.status ?? null,
    };
    return { summary, events, delivery };
  }

  async detail(userId: string, digestId: string): Promise<DigestDetailResponse> {
    const { summary, events } = await this.load(userId, digestId);
    return { ...summary, displayDate: digestDisplayDate(summary.localDate), events };
  }

  /** Never sends. Uses the frozen email content when it exists, otherwise renders the snapshot with the same renderer. */
  async preview(userId: string, digestId: string): Promise<DigestPreviewResponse> {
    const { summary, events, delivery } = await this.load(userId, digestId);
    const rendered = renderDigestEmail({ localDate: summary.localDate, events });
    return {
      id: summary.id,
      localDate: summary.localDate,
      displayDate: rendered.displayDate,
      subject: delivery?.subject ?? rendered.subject,
      isEmpty: summary.isEmpty,
      eventCount: summary.eventCount,
      events,
      html: delivery?.htmlBody ?? rendered.html,
    };
  }

  async dashboard(userId: string, now: Date = new Date()): Promise<DashboardSummary> {
    const [counts, latest] = await Promise.all([this.store.dashboardCounts(userId), this.store.listDigests(userId, 1, 1)]);
    const next = nextDigestSend(now);
    return { ...counts, latestDigest: latest.items[0] ?? null, nextDigest: { localDate: next.localDate, sendAt: next.sendAt.toISOString() } };
  }
}

/** Used when no database is configured (unit tests). */
export function createMemoryDigestApi(): DigestApi {
  return {
    async list(_userId, page, pageSize) {
      return { items: [], page, pageSize, total: 0 };
    },
    async detail() {
      throw new NotFoundError("The digest was not found.");
    },
    async preview() {
      throw new NotFoundError("The digest was not found.");
    },
    async dashboard(_userId, now = new Date()) {
      const next = nextDigestSend(now);
      return {
        activeSources: 0,
        articlesCollected: 0,
        eventsDetected: 0,
        latestDigest: null,
        nextDigest: { localDate: next.localDate, sendAt: next.sendAt.toISOString() },
      };
    },
  };
}
