import type { Pool, QueryResultRow } from "pg";

import type { DigestSnapshotEvent, DigestSummary } from "@aidnd/contracts";
import { digestSubject, isDigestFrozen, type DailyDigestStatus, type DeliveryState, type DigestBuildMode } from "@aidnd/domain";

import { dateOnly } from "../db/repositories.js";
import { PostgresTransactionManager, type TransactionClient } from "../db/transaction.js";
import { normalizeDatabaseError, ValidationError } from "../errors/index.js";
import { safeHttpUrl } from "./render.js";

type Executor = Pool | TransactionClient;
type Timestamp = Date | string;

const iso = (value: Timestamp): string => (value instanceof Date ? value : new Date(value)).toISOString();
const nullableIso = (value: Timestamp | null): string | null => (value === null ? null : iso(value));

async function rows<T extends QueryResultRow>(executor: Executor, sql: string, values: unknown[] = []): Promise<T[]> {
  try {
    return (await executor.query<T>(sql, values)).rows;
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
}

export const DIGEST_READY_EVENT = "digest.ready";
export const DIGEST_DELIVER_EVENT = "digest.deliver";

export type DigestRecord = {
  id: string;
  userId: string;
  localDate: string;
  status: DailyDigestStatus;
  builtAt: string | null;
  sentAt: string | null;
  failureCode: string | null;
};

export type DeliveryRecord = {
  id: string;
  digestId: string;
  status: DeliveryState;
  idempotencyKey: string;
  provider: string | null;
  providerMessageId: string | null;
  attemptCount: number;
  recipientEmail: string;
  senderEmail: string;
  subject: string;
  htmlBody: string;
  textBody: string;
};

export type BuildDigestInput = {
  userId: string;
  localDate: string;
  mode: DigestBuildMode;
  cutoffAt: Date;
  sendAt: Date;
  /** Degraded fallback: freeze an empty snapshot and record why. */
  forceEmpty?: boolean;
  failureCode?: string | null;
};

export type BuildDigestResult = { digest: DigestRecord; rebuilt: boolean; eventCount: number };

type DigestRow = QueryResultRow & {
  id: string;
  userId: string;
  localDate: Date | string;
  status: DailyDigestStatus;
  builtAt: Timestamp | null;
  sentAt: Timestamp | null;
  failureCode: string | null;
};

const digestColumns = `id, user_id AS "userId", local_date AS "localDate", status, built_at AS "builtAt",
  sent_at AS "sentAt", failure_code AS "failureCode"`;

function mapDigest(row: DigestRow): DigestRecord {
  return {
    id: row.id,
    userId: row.userId,
    localDate: dateOnly(row.localDate),
    status: row.status,
    builtAt: nullableIso(row.builtAt),
    sentAt: nullableIso(row.sentAt),
    failureCode: row.failureCode,
  };
}

type DeliveryRow = QueryResultRow & Omit<DeliveryRecord, never>;
const deliveryColumns = `id, digest_id AS "digestId", status, idempotency_key AS "idempotencyKey", provider,
  provider_message_id AS "providerMessageId", attempt_count AS "attemptCount", recipient_email AS "recipientEmail",
  sender_email AS "senderEmail", subject, html_body AS "htmlBody", text_body AS "textBody"`;

type QualifyingRow = QueryResultRow & {
  eventId: string;
  titleVi: string;
  summaryVi: string;
  articleId: string;
  sourceId: string;
  sourceName: string;
  websiteUrl: string;
  rssUrl: string | null;
  originalTitle: string;
  originalUrl: string;
  publishedAt: Timestamp | null;
  sortTime: Timestamp;
};

type SnapshotArticle = {
  articleId: string;
  sourceId: string;
  sourceName: string;
  originalTitle: string;
  originalUrl: string;
  publishedAt: string | null;
};
type SnapshotSource = { sourceId: string; name: string; websiteUrl: string; rssUrl: string | null };

/** JST calendar date of an Article: published date, or discovery date as fallback (same rule as the Event API). */
const ARTICLE_JST_DATE = `COALESCE(a.published_date_jst, (a.discovered_at AT TIME ZONE 'Asia/Tokyo')::date)`;

export class PostgresDigestStore {
  private readonly transactions: PostgresTransactionManager;

  constructor(private readonly pool: Pool) {
    this.transactions = new PostgresTransactionManager(pool);
  }

  async listDigestUserIds(): Promise<string[]> {
    const result = await rows<{ userId: string }>(
      this.pool,
      `SELECT us.user_id AS "userId" FROM user_settings us JOIN users u ON u.id = us.user_id
       WHERE u.disabled_at IS NULL ORDER BY us.user_id`,
    );
    return result.map((row) => row.userId);
  }

  async getRecipient(userId: string): Promise<string | null> {
    const result = await rows<{ email: string }>(
      this.pool,
      `SELECT recipient_email AS email FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    return result[0]?.email ?? null;
  }

  /**
   * Creates/reuses the one Digest for (user, date) and (re)builds its snapshot
   * while it is still building. Frozen Digests (ready/sending/sent/failed) are
   * returned untouched. Finalize freezes the snapshot and schedules delivery via
   * the outbox in the same transaction.
   */
  async buildDigest(input: BuildDigestInput): Promise<BuildDigestResult> {
    return this.transactions.transaction(async (tx) => {
      await rows(
        tx,
        `INSERT INTO daily_digests (user_id, local_date, status) VALUES ($1, $2, 'building')
         ON CONFLICT (user_id, local_date) DO NOTHING`,
        [input.userId, input.localDate],
      );
      const locked = await rows<DigestRow>(
        tx,
        `SELECT ${digestColumns} FROM daily_digests WHERE user_id = $1 AND local_date = $2 FOR UPDATE`,
        [input.userId, input.localDate],
      );
      const digest = mapDigest(locked[0]!);
      if (isDigestFrozen(digest.status)) {
        const count = await rows<{ count: number }>(tx, `SELECT COUNT(*)::int AS count FROM digest_events WHERE digest_id = $1`, [digest.id]);
        return { digest, rebuilt: false, eventCount: count[0]?.count ?? 0 };
      }

      const qualifying = input.forceEmpty
        ? []
        : await rows<QualifyingRow>(
            tx,
            `SELECT e.id AS "eventId", e.title_vi AS "titleVi", e.summary_vi AS "summaryVi",
                    a.id AS "articleId", a.source_id AS "sourceId", s.name AS "sourceName",
                    s.website_url AS "websiteUrl", s.rss_url AS "rssUrl",
                    a.original_title AS "originalTitle", a.original_url AS "originalUrl",
                    a.published_at AS "publishedAt", COALESCE(a.published_at, a.discovered_at) AS "sortTime"
             FROM events e
             JOIN event_articles ea ON ea.event_id = e.id
             JOIN articles a ON a.id = ea.article_id
             JOIN sources s ON s.id = a.source_id
             WHERE e.user_id = $1 AND s.user_id = $1
               AND e.status = 'active' AND e.processing_status = 'processed' AND e.summary_vi IS NOT NULL
               AND a.processing_status = 'processed'
               AND ${ARTICLE_JST_DATE} = $2::date
               AND a.discovered_at <= $3::timestamptz
             ORDER BY "sortTime" DESC, a.id`,
            [input.userId, input.localDate, input.cutoffAt.toISOString()],
          );

      const events = groupSnapshot(qualifying);
      await rows(tx, `DELETE FROM digest_events WHERE digest_id = $1`, [digest.id]);
      for (const event of events) {
        await rows(
          tx,
          `INSERT INTO digest_events (digest_id, event_id, position, title_vi_snapshot, summary_vi_snapshot, article_snapshot, source_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [digest.id, event.eventId, event.position, event.titleVi, event.summaryVi, JSON.stringify(event.articles), JSON.stringify(event.sources)],
        );
      }

      if (input.mode === "draft") {
        return { digest, rebuilt: true, eventCount: events.length };
      }

      validateSnapshot(events);
      const finalized = await rows<DigestRow>(
        tx,
        `UPDATE daily_digests SET status = 'ready', built_at = now(), failure_code = $2, updated_at = now()
         WHERE id = $1 RETURNING ${digestColumns}`,
        [digest.id, input.failureCode ?? null],
      );
      // Articles of date D that existed by the cutoff but did not finish AI processing.
      await rows(
        tx,
        `UPDATE articles a SET missed_digest_cutoff = true, updated_at = now()
         FROM sources s
         WHERE s.id = a.source_id AND s.user_id = $1 AND ${ARTICLE_JST_DATE} = $2::date
           AND a.discovered_at <= $3::timestamptz AND a.processing_status <> 'processed'
           AND a.missed_digest_cutoff = false`,
        [input.userId, input.localDate, input.cutoffAt.toISOString()],
      );
      await rows(
        tx,
        `INSERT INTO outbox_events (event_key, event_type, aggregate_type, aggregate_id, payload, available_at)
         VALUES ($1, $2, 'daily_digest', $3::uuid, jsonb_build_object('digestId', $3::uuid), GREATEST($4::timestamptz, now()))
         ON CONFLICT (event_key) DO NOTHING`,
        [`${DIGEST_READY_EVENT}:${digest.id}`, DIGEST_READY_EVENT, digest.id, input.sendAt.toISOString()],
      );
      return { digest: mapDigest(finalized[0]!), rebuilt: true, eventCount: events.length };
    });
  }

  async getDigest(digestId: string, userId?: string): Promise<DigestRecord | null> {
    const result = await rows<DigestRow>(
      this.pool,
      `SELECT ${digestColumns} FROM daily_digests WHERE id = $1 AND ($2::uuid IS NULL OR user_id = $2)`,
      [digestId, userId ?? null],
    );
    return result[0] ? mapDigest(result[0]) : null;
  }

  async getSnapshotEvents(digestId: string): Promise<DigestSnapshotEvent[]> {
    const result = await rows<{
      eventId: string;
      position: number;
      titleVi: string;
      summaryVi: string;
      articles: SnapshotArticle[];
      sources: SnapshotSource[];
    }>(
      this.pool,
      `SELECT event_id AS "eventId", position, title_vi_snapshot AS "titleVi", summary_vi_snapshot AS "summaryVi",
              article_snapshot AS articles, source_snapshot AS sources
       FROM digest_events WHERE digest_id = $1 ORDER BY position`,
      [digestId],
    );
    return result.map((row) => ({
      eventId: row.eventId,
      position: row.position,
      titleVi: row.titleVi,
      summaryVi: row.summaryVi,
      sources: row.sources.map((source) => source.name),
      articles: row.articles.map((article) => ({
        articleId: article.articleId,
        sourceName: article.sourceName,
        originalTitle: article.originalTitle,
        originalUrl: article.originalUrl,
        publishedAt: article.publishedAt ?? null,
      })),
    }));
  }

  async getDelivery(digestId: string): Promise<DeliveryRecord | null> {
    const result = await rows<DeliveryRow>(this.pool, `SELECT ${deliveryColumns} FROM email_deliveries WHERE digest_id = $1`, [digestId]);
    return result[0] ?? null;
  }

  /** Creates the single logical email for a Digest (content frozen), or returns the existing one. */
  async ensureDelivery(input: {
    digestId: string;
    idempotencyKey: string;
    provider: string;
    recipientEmail: string;
    senderEmail: string;
    subject: string;
    htmlBody: string;
    textBody: string;
  }): Promise<DeliveryRecord> {
    await rows(
      this.pool,
      `INSERT INTO email_deliveries (digest_id, provider, idempotency_key, status, recipient_email, sender_email, subject, html_body, text_body)
       VALUES ($1, $2, $3, 'pending', $4, $5, $6, $7, $8)
       ON CONFLICT (digest_id) DO NOTHING`,
      [input.digestId, input.provider, input.idempotencyKey, input.recipientEmail, input.senderEmail, input.subject, input.htmlBody, input.textBody],
    );
    return (await this.getDelivery(input.digestId))!;
  }

  /** Atomically moves a delivery into "sending" (stale "sending" is reclaimable after a crash). */
  async claimDelivery(deliveryId: string): Promise<DeliveryRecord | null> {
    return this.transactions.transaction(async (tx) => {
      const claimed = await rows<DeliveryRow>(
        tx,
        `UPDATE email_deliveries SET status = 'sending', attempt_count = attempt_count + 1, updated_at = now()
         WHERE id = $1 AND (status IN ('pending', 'failed', 'unknown')
                            OR (status = 'sending' AND updated_at < now() - interval '5 minutes'))
         RETURNING ${deliveryColumns}`,
        [deliveryId],
      );
      if (!claimed[0]) return null;
      await rows(
        tx,
        `UPDATE daily_digests SET status = 'sending', updated_at = now() WHERE id = $1 AND status IN ('ready', 'failed')`,
        [claimed[0].digestId],
      );
      return claimed[0];
    });
  }

  async markAccepted(delivery: DeliveryRecord, provider: string, providerMessageId: string, delivered = false): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await rows(
        tx,
        `UPDATE email_deliveries
         SET status = $4, provider = $2, provider_message_id = COALESCE(NULLIF($3, ''), provider_message_id),
             accepted_at = COALESCE(accepted_at, now()),
             delivered_at = CASE WHEN $4 = 'delivered' THEN COALESCE(delivered_at, now()) ELSE delivered_at END,
             last_error_code = NULL, updated_at = now()
         WHERE id = $1 AND status IN ('sending', 'unknown', 'failed', 'pending')`,
        [delivery.id, provider, providerMessageId, delivered ? "delivered" : "accepted"],
      );
      await rows(
        tx,
        `UPDATE daily_digests SET status = 'sent', sent_at = COALESCE(sent_at, now()), failure_code = NULL, updated_at = now()
         WHERE id = $1 AND status <> 'sent'`,
        [delivery.digestId],
      );
    });
  }

  async markFailure(
    delivery: DeliveryRecord,
    input: { status: "failed" | "unknown"; errorCode: string; providerMessageId?: string | null; final: boolean },
  ): Promise<void> {
    await this.transactions.transaction(async (tx) => {
      await rows(
        tx,
        `UPDATE email_deliveries
         SET status = $2, last_error_code = $3, last_error_at = now(),
             provider_message_id = COALESCE($4, provider_message_id), updated_at = now()
         WHERE id = $1 AND status = 'sending'`,
        [delivery.id, input.status, input.errorCode, input.providerMessageId ?? null],
      );
      if (input.final) {
        await rows(
          tx,
          `UPDATE daily_digests SET status = 'failed', failure_code = $2, updated_at = now() WHERE id = $1 AND status <> 'sent'`,
          [delivery.digestId, input.errorCode],
        );
      }
    });
  }

  /** Marks an unsent Digest failed when no email could even be created (e.g. sender not configured). */
  async markDigestFailed(digestId: string, errorCode: string): Promise<void> {
    await rows(
      this.pool,
      `UPDATE daily_digests SET status = 'failed', failure_code = $2, updated_at = now() WHERE id = $1 AND status <> 'sent'`,
      [digestId, errorCode],
    );
  }

  async scheduleDeliveryRetry(digestId: string, attempt: number, delayMs: number): Promise<void> {
    await rows(
      this.pool,
      `INSERT INTO outbox_events (event_key, event_type, aggregate_type, aggregate_id, payload, available_at)
       VALUES ($1, $2, 'daily_digest', $3::uuid, jsonb_build_object('digestId', $3::uuid), now() + make_interval(secs => $4::int))
       ON CONFLICT (event_key) DO NOTHING`,
      [`${DIGEST_DELIVER_EVENT}:${digestId}:${attempt}`, DIGEST_DELIVER_EVENT, digestId, Math.ceil(delayMs / 1000)],
    );
  }

  /** Applies a signed provider webhook at most once (de-duplicated by webhook id). */
  async applyDeliveryWebhook(input: {
    webhookId: string;
    eventType: string;
    providerMessageId: string;
    status: "accepted" | "delivered" | "failed";
  }): Promise<"applied" | "duplicate" | "unknown_message"> {
    return this.transactions.transaction(async (tx) => {
      const inserted = await rows(
        tx,
        `INSERT INTO email_webhook_events (id, provider, event_type) VALUES ($1, 'resend', $2)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [input.webhookId, input.eventType],
      );
      if (inserted.length === 0) return "duplicate";
      const deliveries = await rows<DeliveryRow>(
        tx,
        `SELECT ${deliveryColumns} FROM email_deliveries WHERE provider_message_id = $1 FOR UPDATE`,
        [input.providerMessageId],
      );
      const delivery = deliveries[0];
      if (!delivery) return "unknown_message";

      if (input.status === "delivered") {
        await rows(
          tx,
          `UPDATE email_deliveries SET status = 'delivered', delivered_at = COALESCE(delivered_at, now()), updated_at = now()
           WHERE id = $1 AND status IN ('accepted', 'unknown', 'sending')`,
          [delivery.id],
        );
      } else if (input.status === "failed") {
        // Bounce after acceptance: record it; the Digest stays "sent" and is never resent.
        await rows(
          tx,
          `UPDATE email_deliveries SET status = 'failed', last_error_code = 'PROVIDER_REPORTED_FAILURE', last_error_at = now(), updated_at = now()
           WHERE id = $1 AND status IN ('accepted', 'unknown', 'sending')`,
          [delivery.id],
        );
      } else {
        await rows(
          tx,
          `UPDATE email_deliveries SET status = 'accepted', accepted_at = COALESCE(accepted_at, now()), updated_at = now()
           WHERE id = $1 AND status IN ('unknown', 'sending')`,
          [delivery.id],
        );
      }
      if (input.status !== "failed") {
        // The provider has the message: the Digest counts as sent.
        await rows(
          tx,
          `UPDATE daily_digests SET status = 'sent', sent_at = COALESCE(sent_at, now()), updated_at = now()
           WHERE id = $1 AND status <> 'sent'`,
          [delivery.digestId],
        );
      }
      return "applied";
    });
  }

  // ------------------------------------------------------------------ read API

  async listDigests(userId: string, page: number, pageSize: number): Promise<{ items: DigestSummary[]; total: number }> {
    const total = await rows<{ total: number }>(this.pool, `SELECT COUNT(*)::int AS total FROM daily_digests WHERE user_id = $1`, [userId]);
    const result = await rows<DigestRow & { eventCount: number; deliveryStatus: DeliveryState | null }>(
      this.pool,
      `SELECT d.id, d.user_id AS "userId", d.local_date AS "localDate", d.status, d.built_at AS "builtAt",
              d.sent_at AS "sentAt", d.failure_code AS "failureCode",
              (SELECT COUNT(*)::int FROM digest_events de WHERE de.digest_id = d.id) AS "eventCount",
              ed.status AS "deliveryStatus"
       FROM daily_digests d LEFT JOIN email_deliveries ed ON ed.digest_id = d.id
       WHERE d.user_id = $1
       ORDER BY d.local_date DESC, d.id
       LIMIT $2 OFFSET $3`,
      [userId, pageSize, (page - 1) * pageSize],
    );
    return { items: result.map(toSummary), total: total[0]?.total ?? 0 };
  }

  async dashboardCounts(userId: string): Promise<{ activeSources: number; articlesCollected: number; eventsDetected: number }> {
    const result = await rows<{ activeSources: number; articlesCollected: number; eventsDetected: number }>(
      this.pool,
      `SELECT
         (SELECT COUNT(*)::int FROM sources WHERE user_id = $1 AND enabled AND deleted_at IS NULL) AS "activeSources",
         (SELECT COUNT(*)::int FROM articles a JOIN sources s ON s.id = a.source_id WHERE s.user_id = $1) AS "articlesCollected",
         (SELECT COUNT(*)::int FROM events WHERE user_id = $1) AS "eventsDetected"`,
      [userId],
    );
    return result[0]!;
  }
}

export function toSummary(row: DigestRow & { eventCount: number; deliveryStatus: DeliveryState | null }): DigestSummary {
  const digest = mapDigest(row);
  return {
    id: digest.id,
    localDate: digest.localDate,
    status: digest.status,
    subject: digestSubject(digest.localDate),
    eventCount: row.eventCount,
    isEmpty: row.eventCount === 0,
    builtAt: digest.builtAt,
    sentAt: digest.sentAt,
    deliveryStatus: row.deliveryStatus,
  };
}

/** Groups qualifying Article rows into ordered Event snapshots (latest Article first, Event id tie-break). */
function groupSnapshot(rowsIn: QualifyingRow[]): Array<{
  eventId: string;
  position: number;
  titleVi: string;
  summaryVi: string;
  articles: SnapshotArticle[];
  sources: SnapshotSource[];
  latest: number;
}> {
  type Entry = { eventId: string; titleVi: string; summaryVi: string; articles: SnapshotArticle[]; sources: Map<string, SnapshotSource>; latest: number };
  const byEvent = new Map<string, Entry>();
  for (const row of rowsIn) {
    const url = safeHttpUrl(row.originalUrl);
    const entry: Entry =
      byEvent.get(row.eventId) ??
      { eventId: row.eventId, titleVi: row.titleVi, summaryVi: row.summaryVi, articles: [], sources: new Map(), latest: 0 };
    entry.latest = Math.max(entry.latest, new Date(row.sortTime).getTime());
    if (url) {
      entry.articles.push({
        articleId: row.articleId,
        sourceId: row.sourceId,
        sourceName: row.sourceName,
        originalTitle: row.originalTitle,
        originalUrl: url,
        publishedAt: nullableIso(row.publishedAt),
      });
    }
    if (!entry.sources.has(row.sourceId)) {
      entry.sources.set(row.sourceId, { sourceId: row.sourceId, name: row.sourceName, websiteUrl: row.websiteUrl, rssUrl: row.rssUrl });
    }
    byEvent.set(row.eventId, entry);
  }
  return [...byEvent.values()]
    .sort((left, right) => right.latest - left.latest || (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0))
    .map((entry, index) => ({ ...entry, position: index + 1, sources: [...entry.sources.values()] }));
}

function validateSnapshot(events: Array<{ position: number; titleVi: string; summaryVi: string }>): void {
  events.forEach((event, index) => {
    if (event.position !== index + 1) throw new ValidationError("Digest snapshot positions are not contiguous.");
    if (!event.titleVi.trim() || !event.summaryVi.trim()) throw new ValidationError("Digest snapshot has empty content.");
  });
}
