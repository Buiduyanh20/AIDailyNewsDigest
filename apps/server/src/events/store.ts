import type { Pool, QueryResultRow } from "pg";

import type { EventAssociationMethod } from "@aidnd/domain";

import type { PromptArticle, PromptCandidateEvent } from "../ai/prompts.js";
import { PostgresTransactionManager, type TransactionClient } from "../db/transaction.js";
import { ConflictError, NotFoundError, normalizeDatabaseError } from "../errors/index.js";

type Executor = Pool | TransactionClient;
type Timestamp = Date | string;

function iso(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Timestamp | null): string | null {
  return value === null ? null : iso(value);
}

async function rows<T extends QueryResultRow>(executor: Executor, sql: string, values: unknown[] = []): Promise<T[]> {
  try {
    return (await executor.query<T>(sql, values)).rows;
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
}

// ---------------------------------------------------------------------------
// Processing store (used by the process-article worker)
// ---------------------------------------------------------------------------

export type ArticleForProcessing = PromptArticle & {
  sourceId: string;
  userId: string;
  canonicalUrl: string | null;
  processingStatus: string;
  referenceTime: string;
  eventId: string | null;
};

export type CandidateEventRecord = PromptCandidateEvent & { lastSeenAt: string };

export type EventContent = {
  titleVi: string;
  summaryVi: string;
  promptVersion: string;
  model: string;
  provider: string;
};

export type PersistOutcome =
  | {
      kind: "create";
      article: ArticleForProcessing;
      method: EventAssociationMethod;
      content: EventContent;
    }
  | {
      kind: "attach";
      article: ArticleForProcessing;
      eventId: string;
      method: EventAssociationMethod;
      /** null keeps the existing Event title/summary untouched. */
      content: EventContent | null;
    };

export type ProcessingAttemptRecord = {
  articleId: string;
  operation: string;
  status: "succeeded" | "failed";
  provider: string;
  model: string;
  promptVersion: string;
  errorCode: string | null;
  startedAt: string;
  finishedAt: string;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: string | null;
  decision: string | null;
  targetEventId: string | null;
};

export interface EventProcessingStore {
  loadArticle(articleId: string): Promise<ArticleForProcessing | null>;
  /** Atomically moves pending/failed (or stale processing) → processing. */
  claimArticle(articleId: string): Promise<boolean>;
  findExactDuplicateEvent(article: ArticleForProcessing): Promise<string | null>;
  listCandidateEvents(input: {
    userId: string;
    referenceTime: string;
    windowHours: number;
    poolSize: number;
  }): Promise<CandidateEventRecord[]>;
  listEventArticles(eventId: string, limit: number): Promise<PromptArticle[]>;
  recordAttempt(record: ProcessingAttemptRecord): Promise<void>;
  persistOutcome(outcome: PersistOutcome): Promise<{ eventId: string; alreadyAssociated: boolean }>;
  markFailed(articleId: string, errorCode: string): Promise<void>;
}

const STALE_PROCESSING_MINUTES = 15;

type ArticleRow = QueryResultRow & {
  id: string;
  sourceId: string;
  sourceName: string;
  userId: string;
  canonicalUrl: string | null;
  originalUrl: string;
  originalTitle: string;
  originalLanguage: string | null;
  originalExcerpt: string | null;
  originalContent: string | null;
  publishedAt: Timestamp | null;
  discoveredAt: Timestamp;
  processingStatus: string;
  eventId: string | null;
};

function mapArticle(row: ArticleRow): ArticleForProcessing {
  const publishedAt = nullableIso(row.publishedAt);
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    userId: row.userId,
    canonicalUrl: row.canonicalUrl,
    url: row.originalUrl,
    title: row.originalTitle,
    language: row.originalLanguage,
    excerpt: row.originalContent ?? row.originalExcerpt,
    publishedAt,
    referenceTime: publishedAt ?? iso(row.discoveredAt),
    processingStatus: row.processingStatus,
    eventId: row.eventId,
  };
}

export class PostgresEventProcessingStore implements EventProcessingStore {
  private readonly transactions: PostgresTransactionManager;

  constructor(private readonly pool: Pool) {
    this.transactions = new PostgresTransactionManager(pool);
  }

  async loadArticle(articleId: string): Promise<ArticleForProcessing | null> {
    const result = await rows<ArticleRow>(
      this.pool,
      `SELECT a.id, a.source_id AS "sourceId", s.name AS "sourceName", s.user_id AS "userId",
              a.canonical_url AS "canonicalUrl", a.original_url AS "originalUrl",
              a.original_title AS "originalTitle", a.original_language AS "originalLanguage",
              a.original_excerpt AS "originalExcerpt", a.original_content AS "originalContent",
              a.published_at AS "publishedAt", a.discovered_at AS "discoveredAt",
              a.processing_status AS "processingStatus", ea.event_id AS "eventId"
       FROM articles a
       JOIN sources s ON s.id = a.source_id
       LEFT JOIN event_articles ea ON ea.article_id = a.id
       WHERE a.id = $1`,
      [articleId],
    );
    return result[0] ? mapArticle(result[0]) : null;
  }

  async claimArticle(articleId: string): Promise<boolean> {
    const result = await rows(
      this.pool,
      `UPDATE articles SET processing_status = 'processing', processing_error_code = NULL, updated_at = now()
       WHERE id = $1
         AND NOT EXISTS (SELECT 1 FROM event_articles ea WHERE ea.article_id = articles.id)
         AND (processing_status IN ('pending', 'failed')
              OR (processing_status = 'processing' AND updated_at < now() - make_interval(mins => $2::int)))
       RETURNING id`,
      [articleId, STALE_PROCESSING_MINUTES],
    );
    return result.length === 1;
  }

  async findExactDuplicateEvent(article: ArticleForProcessing): Promise<string | null> {
    if (!article.canonicalUrl) return null;
    const result = await rows<{ eventId: string }>(
      this.pool,
      `SELECT ea.event_id AS "eventId"
       FROM articles other
       JOIN sources s ON s.id = other.source_id
       JOIN event_articles ea ON ea.article_id = other.id
       JOIN events e ON e.id = ea.event_id
       WHERE other.canonical_url = $1 AND other.id <> $2 AND s.user_id = $3 AND e.user_id = $3
       ORDER BY ea.created_at, ea.event_id
       LIMIT 1`,
      [article.canonicalUrl, article.id, article.userId],
    );
    return result[0]?.eventId ?? null;
  }

  async listCandidateEvents(input: {
    userId: string;
    referenceTime: string;
    windowHours: number;
    poolSize: number;
  }): Promise<CandidateEventRecord[]> {
    type Row = QueryResultRow & {
      eventId: string;
      titleVi: string;
      summaryVi: string | null;
      lastSeenAt: Timestamp;
      members: PromptCandidateEvent["articles"];
    };
    const result = await rows<Row>(
      this.pool,
      `SELECT e.id AS "eventId", e.title_vi AS "titleVi", e.summary_vi AS "summaryVi",
              e.last_seen_at AS "lastSeenAt", COALESCE(m.members, '[]'::json) AS members
       FROM events e
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object(
                  'id', recent.id, 'sourceName', recent.source_name, 'title', recent.original_title,
                  'language', recent.original_language, 'publishedAt', recent.published_at
                ) ORDER BY recent.sort_time DESC, recent.id) AS members
         FROM (
           SELECT a.id, s.name AS source_name, a.original_title, a.original_language, a.published_at,
                  COALESCE(a.published_at, a.discovered_at) AS sort_time
           FROM event_articles ea
           JOIN articles a ON a.id = ea.article_id
           JOIN sources s ON s.id = a.source_id
           WHERE ea.event_id = e.id
           ORDER BY sort_time DESC, a.id
           LIMIT 3
         ) recent
       ) m ON true
       WHERE e.user_id = $1 AND e.status = 'active'
         AND e.last_seen_at >= $2::timestamptz - make_interval(hours => $3::int)
         AND e.first_seen_at <= $2::timestamptz + make_interval(hours => $3::int)
       ORDER BY e.last_seen_at DESC, e.id
       LIMIT $4`,
      [input.userId, input.referenceTime, input.windowHours, input.poolSize],
    );
    return result.map((row) => ({
      eventId: row.eventId,
      titleVi: row.titleVi,
      summaryVi: row.summaryVi,
      lastSeenAt: iso(row.lastSeenAt),
      articles: row.members,
    }));
  }

  async listEventArticles(eventId: string, limit: number): Promise<PromptArticle[]> {
    const result = await rows<ArticleRow>(
      this.pool,
      `SELECT a.id, a.source_id AS "sourceId", s.name AS "sourceName", s.user_id AS "userId",
              a.canonical_url AS "canonicalUrl", a.original_url AS "originalUrl",
              a.original_title AS "originalTitle", a.original_language AS "originalLanguage",
              a.original_excerpt AS "originalExcerpt", a.original_content AS "originalContent",
              a.published_at AS "publishedAt", a.discovered_at AS "discoveredAt",
              a.processing_status AS "processingStatus", ea.event_id AS "eventId"
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       JOIN sources s ON s.id = a.source_id
       WHERE ea.event_id = $1
       ORDER BY COALESCE(a.published_at, a.discovered_at) DESC, a.id
       LIMIT $2`,
      [eventId, limit],
    );
    return result.map((row) => {
      const article = mapArticle(row);
      return {
        id: article.id,
        sourceName: article.sourceName,
        title: article.title,
        language: article.language,
        publishedAt: article.publishedAt,
        url: article.url,
        excerpt: article.excerpt,
      };
    });
  }

  async recordAttempt(record: ProcessingAttemptRecord): Promise<void> {
    await rows(
      this.pool,
      `INSERT INTO processing_attempts (
         entity_type, entity_id, operation, attempt_number, status, provider, model, prompt_version,
         error_code, started_at, finished_at, latency_ms, input_tokens, output_tokens, total_tokens,
         estimated_cost, decision, target_event_id
       )
       SELECT 'article', $1, $2,
              COALESCE((SELECT MAX(attempt_number) FROM processing_attempts
                        WHERE entity_type = 'article' AND entity_id = $1 AND operation = $2), 0) + 1,
              $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16`,
      [
        record.articleId,
        record.operation,
        record.status,
        record.provider,
        record.model,
        record.promptVersion,
        record.errorCode,
        record.startedAt,
        record.finishedAt,
        record.latencyMs,
        record.inputTokens,
        record.outputTokens,
        record.totalTokens,
        record.estimatedCost,
        record.decision,
        record.targetEventId,
      ],
    );
  }

  async persistOutcome(outcome: PersistOutcome): Promise<{ eventId: string; alreadyAssociated: boolean }> {
    const { article } = outcome;
    return this.transactions.transaction(async (tx) => {
      const locked = await rows<{ processingStatus: string }>(
        tx,
        `SELECT processing_status AS "processingStatus" FROM articles WHERE id = $1 FOR UPDATE`,
        [article.id],
      );
      if (!locked[0]) throw new NotFoundError("The article was not found.");

      const existing = await rows<{ eventId: string }>(
        tx,
        `SELECT event_id AS "eventId" FROM event_articles WHERE article_id = $1`,
        [article.id],
      );
      if (existing[0]) {
        // Another run already associated this Article: idempotent no-op.
        return { eventId: existing[0].eventId, alreadyAssociated: true };
      }
      if (locked[0].processingStatus !== "processing") {
        throw new ConflictError("The article is no longer claimed for processing.");
      }

      let eventId: string;
      if (outcome.kind === "create") {
        const created = await rows<{ id: string }>(
          tx,
          `INSERT INTO events (
             user_id, title_vi, summary_vi, status, processing_status, first_seen_at, last_seen_at,
             prompt_version, model, provider
           ) VALUES ($1, $2, $3, 'active', 'processed', $4, $4, $5, $6, $7)
           RETURNING id`,
          [
            article.userId,
            outcome.content.titleVi,
            outcome.content.summaryVi,
            article.referenceTime,
            outcome.content.promptVersion,
            outcome.content.model,
            outcome.content.provider,
          ],
        );
        eventId = created[0]!.id;
      } else {
        const target = await rows<{ id: string }>(
          tx,
          `SELECT id FROM events WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [outcome.eventId, article.userId],
        );
        if (!target[0]) throw new NotFoundError("The target event was not found.");
        eventId = target[0].id;

        if (outcome.content) {
          await rows(
            tx,
            `UPDATE events
             SET title_vi = $2, summary_vi = $3, processing_status = 'processed',
                 first_seen_at = LEAST(first_seen_at, $4::timestamptz),
                 last_seen_at = GREATEST(last_seen_at, $4::timestamptz),
                 prompt_version = $5, model = $6, provider = $7, updated_at = now()
             WHERE id = $1`,
            [
              eventId,
              outcome.content.titleVi,
              outcome.content.summaryVi,
              article.referenceTime,
              outcome.content.promptVersion,
              outcome.content.model,
              outcome.content.provider,
            ],
          );
        } else {
          await rows(
            tx,
            `UPDATE events
             SET first_seen_at = LEAST(first_seen_at, $2::timestamptz),
                 last_seen_at = GREATEST(last_seen_at, $2::timestamptz),
                 updated_at = now()
             WHERE id = $1`,
            [eventId, article.referenceTime],
          );
        }
      }

      await rows(
        tx,
        `INSERT INTO event_articles (event_id, article_id, association_method) VALUES ($1, $2, $3)`,
        [eventId, article.id, outcome.method],
      );
      await rows(
        tx,
        `UPDATE articles SET processing_status = 'processed', processing_error_code = NULL, updated_at = now()
         WHERE id = $1`,
        [article.id],
      );
      return { eventId, alreadyAssociated: false };
    });
  }

  async markFailed(articleId: string, errorCode: string): Promise<void> {
    await rows(
      this.pool,
      `UPDATE articles SET processing_status = 'failed', processing_error_code = $2, updated_at = now()
       WHERE id = $1 AND processing_status = 'processing'`,
      [articleId, errorCode],
    );
  }
}

// ---------------------------------------------------------------------------
// Read store (News & Events API)
// ---------------------------------------------------------------------------

export type EventSourceRef = { id: string; name: string };

export type EventListItemRecord = {
  id: string;
  titleVi: string;
  summaryVi: string | null;
  processingStatus: string;
  firstSeenAt: string;
  lastSeenAt: string;
  latestArticleAt: string;
  articleCount: number;
  sources: EventSourceRef[];
};

export type EventArticleRecord = {
  id: string;
  sourceId: string;
  sourceName: string;
  originalTitle: string;
  originalUrl: string;
  originalLanguage: string | null;
  publishedAt: string | null;
  publishedDateJst: string | null;
  discoveredAt: string;
};

export type EventDetailRecord = Omit<EventListItemRecord, "sources"> & {
  sources: Array<EventSourceRef & { websiteUrl: string }>;
  articles: EventArticleRecord[];
};

export type EventListFilter = {
  search?: string;
  date?: string;
  sourceId?: string;
  page: number;
  pageSize: number;
};

export type ArticleOwnershipRecord = { id: string; processingStatus: string; associated: boolean };

export interface EventReadStore {
  listEvents(userId: string, filter: EventListFilter): Promise<{ items: EventListItemRecord[]; total: number }>;
  getEvent(userId: string, eventId: string): Promise<EventDetailRecord | null>;
  findArticleForUser(userId: string, articleId: string): Promise<ArticleOwnershipRecord | null>;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

type EventSummaryRow = QueryResultRow & {
  id: string;
  titleVi: string;
  summaryVi: string | null;
  processingStatus: string;
  firstSeenAt: Timestamp;
  lastSeenAt: Timestamp;
  latestArticleAt: Timestamp;
  articleCount: number;
  sources: EventSourceRef[];
};

export class PostgresEventReadStore implements EventReadStore {
  constructor(private readonly pool: Pool) {}

  async listEvents(userId: string, filter: EventListFilter): Promise<{ items: EventListItemRecord[]; total: number }> {
    const values: unknown[] = [userId];
    const clauses = ["e.user_id = $1"];
    const memberArticles = `SELECT 1 FROM event_articles fea JOIN articles fa ON fa.id = fea.article_id
                            JOIN sources fs ON fs.id = fa.source_id WHERE fea.event_id = e.id`;

    const search = filter.search?.trim();
    if (search) {
      values.push(`%${escapeLike(search)}%`);
      const parameter = `$${values.length}`;
      clauses.push(
        `(e.title_vi ILIKE ${parameter} ESCAPE '\\' OR EXISTS (${memberArticles}
           AND (fa.original_title ILIKE ${parameter} ESCAPE '\\' OR fs.name ILIKE ${parameter} ESCAPE '\\')))`,
      );
    }
    if (filter.date) {
      values.push(filter.date);
      clauses.push(
        `EXISTS (${memberArticles}
           AND COALESCE(fa.published_date_jst, (fa.discovered_at AT TIME ZONE 'Asia/Tokyo')::date) = $${values.length}::date)`,
      );
    }
    if (filter.sourceId) {
      values.push(filter.sourceId);
      clauses.push(`EXISTS (${memberArticles} AND fa.source_id = $${values.length})`);
    }

    const where = clauses.join(" AND ");
    const countRows = await rows<{ total: number }>(
      this.pool,
      `SELECT COUNT(*)::int AS total FROM events e WHERE ${where}`,
      values,
    );

    const offset = (filter.page - 1) * filter.pageSize;
    const result = await rows<EventSummaryRow>(
      this.pool,
      `SELECT e.id, e.title_vi AS "titleVi", e.summary_vi AS "summaryVi",
              e.processing_status AS "processingStatus", e.first_seen_at AS "firstSeenAt",
              e.last_seen_at AS "lastSeenAt",
              MAX(COALESCE(a.published_at, a.discovered_at)) AS "latestArticleAt",
              COUNT(a.id)::int AS "articleCount",
              jsonb_agg(DISTINCT jsonb_build_object('id', s.id, 'name', s.name)) AS sources
       FROM events e
       JOIN event_articles ea ON ea.event_id = e.id
       JOIN articles a ON a.id = ea.article_id
       JOIN sources s ON s.id = a.source_id
       WHERE ${where}
       GROUP BY e.id
       ORDER BY "latestArticleAt" DESC, e.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, filter.pageSize, offset],
    );

    return {
      items: result.map((row) => ({
        id: row.id,
        titleVi: row.titleVi,
        summaryVi: row.summaryVi,
        processingStatus: row.processingStatus,
        firstSeenAt: iso(row.firstSeenAt),
        lastSeenAt: iso(row.lastSeenAt),
        latestArticleAt: iso(row.latestArticleAt),
        articleCount: row.articleCount,
        sources: [...row.sources].sort((left, right) => left.name.localeCompare(right.name)),
      })),
      total: Number(countRows[0]?.total ?? 0),
    };
  }

  async getEvent(userId: string, eventId: string): Promise<EventDetailRecord | null> {
    type EventRow = QueryResultRow & {
      id: string;
      titleVi: string;
      summaryVi: string | null;
      processingStatus: string;
      firstSeenAt: Timestamp;
      lastSeenAt: Timestamp;
    };
    const events = await rows<EventRow>(
      this.pool,
      `SELECT id, title_vi AS "titleVi", summary_vi AS "summaryVi", processing_status AS "processingStatus",
              first_seen_at AS "firstSeenAt", last_seen_at AS "lastSeenAt"
       FROM events WHERE id = $1 AND user_id = $2`,
      [eventId, userId],
    );
    const event = events[0];
    if (!event) return null;

    type ArticleDetailRow = QueryResultRow & {
      id: string;
      sourceId: string;
      sourceName: string;
      sourceWebsiteUrl: string;
      originalTitle: string;
      originalUrl: string;
      originalLanguage: string | null;
      publishedAt: Timestamp | null;
      publishedDateJst: string | null;
      discoveredAt: Timestamp;
    };
    const articleRows = await rows<ArticleDetailRow>(
      this.pool,
      `SELECT a.id, a.source_id AS "sourceId", s.name AS "sourceName", s.website_url AS "sourceWebsiteUrl",
              a.original_title AS "originalTitle", a.original_url AS "originalUrl",
              a.original_language AS "originalLanguage", a.published_at AS "publishedAt",
              a.published_date_jst::text AS "publishedDateJst", a.discovered_at AS "discoveredAt"
       FROM event_articles ea
       JOIN articles a ON a.id = ea.article_id
       JOIN sources s ON s.id = a.source_id
       WHERE ea.event_id = $1
       ORDER BY COALESCE(a.published_at, a.discovered_at) DESC, a.id`,
      [eventId],
    );

    const articles: EventArticleRecord[] = articleRows.map((row) => ({
      id: row.id,
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      originalTitle: row.originalTitle,
      originalUrl: row.originalUrl,
      originalLanguage: row.originalLanguage,
      publishedAt: nullableIso(row.publishedAt),
      publishedDateJst: row.publishedDateJst,
      discoveredAt: iso(row.discoveredAt),
    }));
    const sources = new Map<string, EventSourceRef & { websiteUrl: string }>();
    for (const row of articleRows) {
      sources.set(row.sourceId, { id: row.sourceId, name: row.sourceName, websiteUrl: row.sourceWebsiteUrl });
    }
    const latestArticleAt = articles
      .map((article) => article.publishedAt ?? article.discoveredAt)
      .sort()
      .at(-1);

    return {
      id: event.id,
      titleVi: event.titleVi,
      summaryVi: event.summaryVi,
      processingStatus: event.processingStatus,
      firstSeenAt: iso(event.firstSeenAt),
      lastSeenAt: iso(event.lastSeenAt),
      latestArticleAt: latestArticleAt ?? iso(event.lastSeenAt),
      articleCount: articles.length,
      sources: [...sources.values()].sort((left, right) => left.name.localeCompare(right.name)),
      articles,
    };
  }

  async findArticleForUser(userId: string, articleId: string): Promise<ArticleOwnershipRecord | null> {
    const result = await rows<{ id: string; processingStatus: string; associated: boolean }>(
      this.pool,
      `SELECT a.id, a.processing_status AS "processingStatus",
              EXISTS (SELECT 1 FROM event_articles ea WHERE ea.article_id = a.id) AS associated
       FROM articles a JOIN sources s ON s.id = a.source_id
       WHERE a.id = $1 AND s.user_id = $2`,
      [articleId, userId],
    );
    return result[0] ?? null;
  }
}
