import { randomUUID } from "node:crypto";

import type {
  Article,
  DailyDigest,
  DigestEvent,
  EmailDelivery,
  Event,
  EventArticle,
  JsonValue,
  OutboxEvent,
  ProcessingAttempt,
  Session,
  Source,
  User,
  UserSettings,
} from "@aidnd/domain";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  AppSession,
  AppUser,
  AppUserSettings,
  AuthStore,
} from "./auth-store.js";
import { PostgresTransactionManager, type TransactionClient } from "./transaction.js";
import { normalizeDatabaseError } from "../errors/index.js";
import { normalizeEmail } from "./auth-helpers.js";

type PgExecutor = Pool | PoolClient;
type TimestampValue = Date | string;

function iso(value: TimestampValue): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: TimestampValue | null): string | null {
  return value === null ? null : iso(value);
}

/**
 * Maps a PostgreSQL DATE to "YYYY-MM-DD". node-postgres parses DATE as local
 * midnight, so the local calendar parts are the stored date; toISOString()
 * would shift it to the previous day on UTC+ hosts (e.g. Asia/Tokyo).
 */
export function dateOnly(value: Date | string): string {
  if (!(value instanceof Date)) return value.slice(0, 10);
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

async function queryRows<T extends QueryResultRow>(
  executor: PgExecutor,
  sql: string,
  parameters: unknown[] = [],
): Promise<T[]> {
  try {
    const result = await executor.query<T>(sql, parameters);
    return result.rows;
  } catch (error) {
    throw normalizeDatabaseError(error);
  }
}

function first<T>(rows: T[], message: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(message);
  }
  return row;
}

type UserRow = QueryResultRow & {
  id: string;
  email: string;
  passwordHash: string;
  disabledAt: TimestampValue | null;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    disabledAt: nullableIso(row.disabledAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type SessionRow = QueryResultRow & {
  id: string;
  userId: string;
  expiresAt: TimestampValue;
  lastSeenAt: TimestampValue;
  createdAt: TimestampValue;
};

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: iso(row.expiresAt),
    lastSeenAt: iso(row.lastSeenAt),
    createdAt: iso(row.createdAt),
  };
}

type UserSettingsRow = QueryResultRow & {
  userId: string;
  recipientEmail: string;
  timezone: string;
  sendLocalTime: string;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapUserSettings(row: UserSettingsRow): UserSettings {
  return {
    userId: row.userId,
    recipientEmail: row.recipientEmail,
    timezone: row.timezone,
    sendLocalTime: row.sendLocalTime,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type SourceRow = QueryResultRow & {
  id: string;
  userId: string;
  name: string;
  websiteUrl: string;
  rssUrl: string | null;
  enabled: boolean;
  status: Source["status"];
  lastFetchedAt: TimestampValue | null;
  lastErrorCode: string | null;
  lastErrorAt: TimestampValue | null;
  deletedAt: TimestampValue | null;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapSource(row: SourceRow): Source {
  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    websiteUrl: row.websiteUrl,
    rssUrl: row.rssUrl,
    enabled: row.enabled,
    status: row.status,
    lastFetchedAt: nullableIso(row.lastFetchedAt),
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: nullableIso(row.lastErrorAt),
    deletedAt: nullableIso(row.deletedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type ArticleRow = QueryResultRow & {
  id: string;
  sourceId: string;
  externalId: string | null;
  canonicalUrl: string | null;
  originalUrl: string;
  originalTitle: string;
  originalLanguage: string | null;
  originalExcerpt: string | null;
  originalContent: string | null;
  publishedAt: TimestampValue | null;
  publishedDateJst: Date | string | null;
  discoveredAt: TimestampValue;
  processingStatus: string;
  processingErrorCode: string | null;
  lateArrival: boolean;
  missedDigestCutoff: boolean;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    sourceId: row.sourceId,
    externalId: row.externalId,
    canonicalUrl: row.canonicalUrl,
    originalUrl: row.originalUrl,
    originalTitle: row.originalTitle,
    originalLanguage: row.originalLanguage,
    originalExcerpt: row.originalExcerpt,
    originalContent: row.originalContent,
    publishedAt: nullableIso(row.publishedAt),
    publishedDateJst: row.publishedDateJst === null ? null : dateOnly(row.publishedDateJst),
    discoveredAt: iso(row.discoveredAt),
    processingStatus: row.processingStatus,
    processingErrorCode: row.processingErrorCode,
    lateArrival: row.lateArrival,
    missedDigestCutoff: row.missedDigestCutoff,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type EventRow = QueryResultRow & {
  id: string;
  userId: string;
  titleVi: string;
  summaryVi: string | null;
  status: string;
  processingStatus: string;
  firstSeenAt: TimestampValue;
  lastSeenAt: TimestampValue;
  promptVersion: string | null;
  model: string | null;
  provider: string | null;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapEvent(row: EventRow): Event {
  return {
    id: row.id,
    userId: row.userId,
    titleVi: row.titleVi,
    summaryVi: row.summaryVi,
    status: row.status,
    processingStatus: row.processingStatus,
    firstSeenAt: iso(row.firstSeenAt),
    lastSeenAt: iso(row.lastSeenAt),
    promptVersion: row.promptVersion,
    model: row.model,
    provider: row.provider,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type EventArticleRow = QueryResultRow & {
  eventId: string;
  articleId: string;
  associationMethod: string;
  createdAt: TimestampValue;
};

function mapEventArticle(row: EventArticleRow): EventArticle {
  return {
    eventId: row.eventId,
    articleId: row.articleId,
    associationMethod: row.associationMethod,
    createdAt: iso(row.createdAt),
  };
}

type DailyDigestRow = QueryResultRow & {
  id: string;
  userId: string;
  localDate: Date | string;
  status: DailyDigest["status"];
  builtAt: TimestampValue | null;
  sentAt: TimestampValue | null;
  failureCode: string | null;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapDailyDigest(row: DailyDigestRow): DailyDigest {
  return {
    id: row.id,
    userId: row.userId,
    localDate: dateOnly(row.localDate),
    status: row.status,
    builtAt: nullableIso(row.builtAt),
    sentAt: nullableIso(row.sentAt),
    failureCode: row.failureCode,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type DigestEventRow = QueryResultRow & {
  digestId: string;
  eventId: string;
  position: number;
  titleViSnapshot: string;
  summaryViSnapshot: string;
  articleSnapshot: DigestEvent["articleSnapshot"];
  sourceSnapshot: DigestEvent["sourceSnapshot"];
  createdAt: TimestampValue;
};

function mapDigestEvent(row: DigestEventRow): DigestEvent {
  return {
    digestId: row.digestId,
    eventId: row.eventId,
    position: row.position,
    titleViSnapshot: row.titleViSnapshot,
    summaryViSnapshot: row.summaryViSnapshot,
    articleSnapshot: row.articleSnapshot,
    sourceSnapshot: row.sourceSnapshot,
    createdAt: iso(row.createdAt),
  };
}

type EmailDeliveryRow = QueryResultRow & {
  id: string;
  digestId: string;
  provider: string | null;
  providerMessageId: string | null;
  idempotencyKey: string;
  status: EmailDelivery["status"];
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorAt: TimestampValue | null;
  acceptedAt: TimestampValue | null;
  deliveredAt: TimestampValue | null;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapEmailDelivery(row: EmailDeliveryRow): EmailDelivery {
  return {
    id: row.id,
    digestId: row.digestId,
    provider: row.provider,
    providerMessageId: row.providerMessageId,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    attemptCount: row.attemptCount,
    lastErrorCode: row.lastErrorCode,
    lastErrorAt: nullableIso(row.lastErrorAt),
    acceptedAt: nullableIso(row.acceptedAt),
    deliveredAt: nullableIso(row.deliveredAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type OutboxEventRow = QueryResultRow & {
  id: string;
  eventKey: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonValue;
  status: string;
  attemptCount: number;
  availableAt: TimestampValue;
  processedAt: TimestampValue | null;
  lastErrorCode: string | null;
  createdAt: TimestampValue;
  updatedAt: TimestampValue;
};

function mapOutboxEvent(row: OutboxEventRow): OutboxEvent {
  return {
    id: row.id,
    eventKey: row.eventKey,
    eventType: row.eventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    payload: row.payload,
    status: row.status,
    attemptCount: row.attemptCount,
    availableAt: iso(row.availableAt),
    processedAt: nullableIso(row.processedAt),
    lastErrorCode: row.lastErrorCode,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

type ProcessingAttemptRow = QueryResultRow & {
  id: string;
  entityType: string;
  entityId: string;
  operation: string;
  attemptNumber: number;
  status: string;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  errorCode: string | null;
  startedAt: TimestampValue | null;
  finishedAt: TimestampValue | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: string | null;
  createdAt: TimestampValue;
};

function mapProcessingAttempt(row: ProcessingAttemptRow): ProcessingAttempt {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    operation: row.operation,
    attemptNumber: row.attemptNumber,
    status: row.status,
    provider: row.provider,
    model: row.model,
    promptVersion: row.promptVersion,
    errorCode: row.errorCode,
    startedAt: nullableIso(row.startedAt),
    finishedAt: nullableIso(row.finishedAt),
    latencyMs: row.latencyMs,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    estimatedCost: row.estimatedCost,
    createdAt: iso(row.createdAt),
  };
}

export type NewSource = Pick<Source, "userId" | "name" | "websiteUrl"> &
  Partial<Pick<Source, "rssUrl" | "enabled" | "status">>;

export type NewArticle = Pick<Article, "sourceId" | "originalUrl" | "originalTitle"> &
  Partial<
    Pick<
      Article,
      | "externalId"
      | "canonicalUrl"
      | "originalLanguage"
      | "originalExcerpt"
      | "originalContent"
      | "publishedAt"
      | "publishedDateJst"
      | "discoveredAt"
      | "processingStatus"
      | "processingErrorCode"
      | "lateArrival"
      | "missedDigestCutoff"
    >
  >;

export type NewEvent = Pick<Event, "userId" | "titleVi" | "status" | "processingStatus" | "firstSeenAt" | "lastSeenAt"> &
  Partial<Pick<Event, "summaryVi" | "promptVersion" | "model" | "provider">>;

export type NewEventArticle = Pick<EventArticle, "eventId" | "articleId" | "associationMethod">;
export type NewDailyDigest = Pick<DailyDigest, "userId" | "localDate" | "status"> &
  Partial<Pick<DailyDigest, "builtAt" | "sentAt" | "failureCode">>;
export type NewDigestEvent = Omit<DigestEvent, "createdAt">;
export type NewEmailDelivery = Pick<EmailDelivery, "digestId" | "idempotencyKey"> &
  Partial<
    Pick<
      EmailDelivery,
      | "provider"
      | "providerMessageId"
      | "status"
      | "attemptCount"
      | "lastErrorCode"
      | "lastErrorAt"
      | "acceptedAt"
      | "deliveredAt"
    >
  >;
export type NewOutboxEvent = Pick<OutboxEvent, "eventKey" | "eventType" | "aggregateType" | "aggregateId" | "payload"> &
  Partial<Pick<OutboxEvent, "status" | "attemptCount" | "availableAt" | "processedAt" | "lastErrorCode">>;
export type NewProcessingAttempt = Pick<
  ProcessingAttempt,
  "entityType" | "entityId" | "operation" | "attemptNumber" | "status"
> &
  Partial<
    Pick<
      ProcessingAttempt,
      | "provider"
      | "model"
      | "promptVersion"
      | "errorCode"
      | "startedAt"
      | "finishedAt"
      | "latencyMs"
      | "inputTokens"
      | "outputTokens"
      | "estimatedCost"
    >
  >;

export interface UserRepository {
  create(input: { email: string; passwordHash: string; disabledAt?: string | null }, tx?: TransactionClient): Promise<User>;
  findById(id: string, tx?: TransactionClient): Promise<User | null>;
  findByEmail(email: string, tx?: TransactionClient): Promise<User | null>;
}

export interface SessionRepository {
  create(input: Pick<Session, "id" | "userId" | "expiresAt" | "lastSeenAt">, tx?: TransactionClient): Promise<Session>;
  findById(id: string, tx?: TransactionClient): Promise<Session | null>;
  updateLastSeen(id: string, tx?: TransactionClient): Promise<void>;
  delete(id: string, tx?: TransactionClient): Promise<void>;
  deleteForUser(userId: string, tx?: TransactionClient): Promise<void>;
}

export interface UserSettingsRepository {
  findByUserId(userId: string, tx?: TransactionClient): Promise<UserSettings | null>;
  upsert(
    input: Pick<UserSettings, "userId" | "recipientEmail" | "timezone" | "sendLocalTime">,
    tx?: TransactionClient,
  ): Promise<UserSettings>;
}

export interface SourceRepository {
  create(input: NewSource, tx?: TransactionClient): Promise<Source>;
  findById(id: string, tx?: TransactionClient): Promise<Source | null>;
  findByIdForUser(id: string, userId: string, tx?: TransactionClient): Promise<Source | null>;
  listByUser(userId: string, tx?: TransactionClient): Promise<Source[]>;
  listForUser(
    userId: string,
    options?: { page?: number; pageSize?: number; status?: Source["status"]; search?: string },
    tx?: TransactionClient,
  ): Promise<{ items: Source[]; total: number }>;
  update(id: string, userId: string, patch: Partial<Pick<Source, "name" | "websiteUrl" | "rssUrl" | "enabled">>, tx?: TransactionClient): Promise<Source | null>;
  softDelete(id: string, userId: string, tx?: TransactionClient): Promise<Source | null>;
  markCollectionSucceeded(id: string, fetchedAt: string, tx?: TransactionClient): Promise<Source | null>;
  markCollectionFailed(id: string, errorCode: string, errorAt: string, tx?: TransactionClient): Promise<Source | null>;
}

export interface ArticleRepository {
  create(input: NewArticle, tx?: TransactionClient): Promise<Article>;
  findById(id: string, tx?: TransactionClient): Promise<Article | null>;
  listBySource(sourceId: string, tx?: TransactionClient): Promise<Article[]>;
  findBySourceAndCandidate?(
    sourceId: string,
    candidate: { canonicalUrl?: string | null; externalId?: string | null; fingerprint?: string | null },
    tx?: TransactionClient,
  ): Promise<Article | null>;
}

export interface EventRepository {
  create(input: NewEvent, tx?: TransactionClient): Promise<Event>;
  findByIdForUser(id: string, userId: string, tx?: TransactionClient): Promise<Event | null>;
}

export interface EventArticleRepository {
  create(input: NewEventArticle, tx?: TransactionClient): Promise<EventArticle>;
  listByEvent(eventId: string, tx?: TransactionClient): Promise<EventArticle[]>;
}

export interface DailyDigestRepository {
  create(input: NewDailyDigest, tx?: TransactionClient): Promise<DailyDigest>;
  findByUserAndDate(userId: string, localDate: string, tx?: TransactionClient): Promise<DailyDigest | null>;
}

export interface DigestEventRepository {
  create(input: NewDigestEvent, tx?: TransactionClient): Promise<DigestEvent>;
  listByDigest(digestId: string, tx?: TransactionClient): Promise<DigestEvent[]>;
}

export interface EmailDeliveryRepository {
  create(input: NewEmailDelivery, tx?: TransactionClient): Promise<EmailDelivery>;
  findByDigestId(digestId: string, tx?: TransactionClient): Promise<EmailDelivery | null>;
}

export interface OutboxEventRepository {
  create(input: NewOutboxEvent, tx: TransactionClient): Promise<OutboxEvent>;
  findByEventKey(eventKey: string, tx?: TransactionClient): Promise<OutboxEvent | null>;
}

export interface ProcessingAttemptRepository {
  create(input: NewProcessingAttempt, tx?: TransactionClient): Promise<ProcessingAttempt>;
  listByEntity(entityType: string, entityId: string, tx?: TransactionClient): Promise<ProcessingAttempt[]>;
}

class RepositoryBase {
  constructor(protected readonly pool: Pool) {}

  protected executor(tx?: TransactionClient): PgExecutor {
    return tx ?? this.pool;
  }
}

const userColumns = `id, email, password_hash AS "passwordHash", disabled_at AS "disabledAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const sessionColumns = `id, user_id AS "userId", expires_at AS "expiresAt",
  last_seen_at AS "lastSeenAt", created_at AS "createdAt"`;
const userSettingsColumns = `user_id AS "userId", recipient_email AS "recipientEmail", timezone,
  send_local_time AS "sendLocalTime", created_at AS "createdAt", updated_at AS "updatedAt"`;
const sourceColumns = `id, user_id AS "userId", name, website_url AS "websiteUrl", rss_url AS "rssUrl",
  enabled, status, last_fetched_at AS "lastFetchedAt", last_error_code AS "lastErrorCode",
  last_error_at AS "lastErrorAt", deleted_at AS "deletedAt", created_at AS "createdAt",
  updated_at AS "updatedAt"`;
const articleColumns = `id, source_id AS "sourceId", external_id AS "externalId",
  canonical_url AS "canonicalUrl", original_url AS "originalUrl", original_title AS "originalTitle",
  original_language AS "originalLanguage", original_excerpt AS "originalExcerpt",
  original_content AS "originalContent", published_at AS "publishedAt",
  published_date_jst AS "publishedDateJst", discovered_at AS "discoveredAt",
  processing_status AS "processingStatus", processing_error_code AS "processingErrorCode",
  late_arrival AS "lateArrival", missed_digest_cutoff AS "missedDigestCutoff",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const eventColumns = `id, user_id AS "userId", title_vi AS "titleVi", summary_vi AS "summaryVi",
  status, processing_status AS "processingStatus", first_seen_at AS "firstSeenAt",
  last_seen_at AS "lastSeenAt", prompt_version AS "promptVersion", model, provider,
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const eventArticleColumns = `event_id AS "eventId", article_id AS "articleId",
  association_method AS "associationMethod", created_at AS "createdAt"`;
const dailyDigestColumns = `id, user_id AS "userId", local_date AS "localDate", status,
  built_at AS "builtAt", sent_at AS "sentAt", failure_code AS "failureCode",
  created_at AS "createdAt", updated_at AS "updatedAt"`;
const digestEventColumns = `digest_id AS "digestId", event_id AS "eventId", position,
  title_vi_snapshot AS "titleViSnapshot", summary_vi_snapshot AS "summaryViSnapshot",
  article_snapshot AS "articleSnapshot", source_snapshot AS "sourceSnapshot", created_at AS "createdAt"`;
const emailDeliveryColumns = `id, digest_id AS "digestId", provider,
  provider_message_id AS "providerMessageId", idempotency_key AS "idempotencyKey", status,
  attempt_count AS "attemptCount", last_error_code AS "lastErrorCode", last_error_at AS "lastErrorAt",
  accepted_at AS "acceptedAt", delivered_at AS "deliveredAt", created_at AS "createdAt",
  updated_at AS "updatedAt"`;
const outboxEventColumns = `id, event_key AS "eventKey", event_type AS "eventType",
  aggregate_type AS "aggregateType", aggregate_id AS "aggregateId", payload, status,
  attempt_count AS "attemptCount", available_at AS "availableAt", processed_at AS "processedAt",
  last_error_code AS "lastErrorCode", created_at AS "createdAt", updated_at AS "updatedAt"`;
const processingAttemptColumns = `id, entity_type AS "entityType", entity_id AS "entityId",
  operation, attempt_number AS "attemptNumber", status, provider, model,
  prompt_version AS "promptVersion", error_code AS "errorCode", started_at AS "startedAt",
  finished_at AS "finishedAt", latency_ms AS "latencyMs", input_tokens AS "inputTokens",
  output_tokens AS "outputTokens", estimated_cost::text AS "estimatedCost", created_at AS "createdAt"`;

export class PostgresUserRepository extends RepositoryBase implements UserRepository {
  async create(
    input: { email: string; passwordHash: string; disabledAt?: string | null },
    tx?: TransactionClient,
  ): Promise<User> {
    const rows = await queryRows<UserRow>(
      this.executor(tx),
      `INSERT INTO users (email, password_hash, disabled_at)
       VALUES ($1, $2, $3) RETURNING ${userColumns}`,
      [normalizeEmail(input.email), input.passwordHash, input.disabledAt ?? null],
    );
    return mapUser(first(rows, "User insert returned no row."));
  }

  async findById(id: string, tx?: TransactionClient): Promise<User | null> {
    const rows = await queryRows<UserRow>(this.executor(tx), `SELECT ${userColumns} FROM users WHERE id = $1`, [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findByEmail(email: string, tx?: TransactionClient): Promise<User | null> {
    const rows = await queryRows<UserRow>(
      this.executor(tx),
      `SELECT ${userColumns} FROM users WHERE lower(email) = lower($1)`,
      [normalizeEmail(email)],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }
}

export class PostgresSessionRepository extends RepositoryBase implements SessionRepository {
  async create(
    input: Pick<Session, "id" | "userId" | "expiresAt" | "lastSeenAt">,
    tx?: TransactionClient,
  ): Promise<Session> {
    const rows = await queryRows<SessionRow>(
      this.executor(tx),
      `INSERT INTO sessions (id, user_id, expires_at, last_seen_at)
       VALUES ($1, $2, $3, $4) RETURNING ${sessionColumns}`,
      [input.id, input.userId, input.expiresAt, input.lastSeenAt],
    );
    return mapSession(first(rows, "Session insert returned no row."));
  }

  async findById(id: string, tx?: TransactionClient): Promise<Session | null> {
    const rows = await queryRows<SessionRow>(
      this.executor(tx),
      `SELECT ${sessionColumns} FROM sessions WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapSession(rows[0]) : null;
  }

  async updateLastSeen(id: string, tx?: TransactionClient): Promise<void> {
    await queryRows(this.executor(tx), `UPDATE sessions SET last_seen_at = now() WHERE id = $1`, [id]);
  }

  async delete(id: string, tx?: TransactionClient): Promise<void> {
    await queryRows(this.executor(tx), `DELETE FROM sessions WHERE id = $1`, [id]);
  }

  async deleteForUser(userId: string, tx?: TransactionClient): Promise<void> {
    await queryRows(this.executor(tx), `DELETE FROM sessions WHERE user_id = $1`, [userId]);
  }
}

export class PostgresUserSettingsRepository extends RepositoryBase implements UserSettingsRepository {
  async findByUserId(userId: string, tx?: TransactionClient): Promise<UserSettings | null> {
    const rows = await queryRows<UserSettingsRow>(
      this.executor(tx),
      `SELECT ${userSettingsColumns} FROM user_settings WHERE user_id = $1`,
      [userId],
    );
    return rows[0] ? mapUserSettings(rows[0]) : null;
  }

  async upsert(
    input: Pick<UserSettings, "userId" | "recipientEmail" | "timezone" | "sendLocalTime">,
    tx?: TransactionClient,
  ): Promise<UserSettings> {
    const rows = await queryRows<UserSettingsRow>(
      this.executor(tx),
      `INSERT INTO user_settings (user_id, recipient_email, timezone, send_local_time)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET
         recipient_email = EXCLUDED.recipient_email,
         timezone = EXCLUDED.timezone,
         send_local_time = EXCLUDED.send_local_time,
         updated_at = now()
       RETURNING ${userSettingsColumns}`,
      [input.userId, input.recipientEmail, input.timezone, input.sendLocalTime],
    );
    return mapUserSettings(first(rows, "User settings upsert returned no row."));
  }
}

export class PostgresSourceRepository extends RepositoryBase implements SourceRepository {
  async create(input: NewSource, tx?: TransactionClient): Promise<Source> {
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `INSERT INTO sources (user_id, name, website_url, rss_url, enabled, status)
       VALUES ($1, $2, $3, $4, COALESCE($5, true), COALESCE($6, 'active'))
       RETURNING ${sourceColumns}`,
      [input.userId, input.name, input.websiteUrl, input.rssUrl ?? null, input.enabled ?? null, input.status ?? null],
    );
    return mapSource(first(rows, "Source insert returned no row."));
  }

  async findById(id: string, tx?: TransactionClient): Promise<Source | null> {
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `SELECT ${sourceColumns} FROM sources WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapSource(rows[0]) : null;
  }

  async findByIdForUser(id: string, userId: string, tx?: TransactionClient): Promise<Source | null> {
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `SELECT ${sourceColumns} FROM sources WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
      [id, userId],
    );
    return rows[0] ? mapSource(rows[0]) : null;
  }

  async listByUser(userId: string, tx?: TransactionClient): Promise<Source[]> {
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `SELECT ${sourceColumns} FROM sources WHERE user_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`,
      [userId],
    );
    return rows.map(mapSource);
  }

  async listForUser(
    userId: string,
    options: { page?: number; pageSize?: number; status?: Source["status"]; search?: string } = {},
    tx?: TransactionClient,
  ): Promise<{ items: Source[]; total: number }> {
    const page = Math.max(1, Number(options.page ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(options.pageSize ?? 20)));
    const status = options.status ?? null;
    const search = (options.search ?? "").trim();
    const values: unknown[] = [userId];
    const clauses: string[] = ["user_id = $1", "deleted_at IS NULL"];
    if (status) {
      clauses.push(`status = $${values.length + 1}`);
      values.push(status);
    }
    if (search) {
      clauses.push(`(lower(name) LIKE $${values.length + 1} OR lower(split_part(website_url, '/', 3)) LIKE $${values.length + 1})`);
      values.push(`%${search.toLowerCase()}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const countRows = await queryRows<{ total: number }>(
      this.executor(tx),
      `SELECT COUNT(*)::int AS total FROM sources ${where}`,
      values,
    );
    const total = Number(countRows[0]?.total ?? 0);
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `SELECT ${sourceColumns} FROM sources ${where}
       ORDER BY created_at DESC, id
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, pageSize, (page - 1) * pageSize],
    );
    return { items: rows.map(mapSource), total };
  }

  async update(
    id: string,
    userId: string,
    patch: Partial<Pick<Source, "name" | "websiteUrl" | "rssUrl" | "enabled">>,
    tx?: TransactionClient,
  ): Promise<Source | null> {
    const changes: string[] = [];
    const values: unknown[] = [];
    if (patch.name !== undefined) {
      changes.push(`name = $${values.length + 1}`);
      values.push(patch.name);
    }
    if (patch.websiteUrl !== undefined) {
      changes.push(`website_url = $${values.length + 1}`);
      values.push(patch.websiteUrl);
    }
    if (patch.rssUrl !== undefined) {
      changes.push(`rss_url = $${values.length + 1}`);
      values.push(patch.rssUrl ?? null);
    }
    if (patch.enabled !== undefined) {
      changes.push(`enabled = $${values.length + 1}`);
      values.push(patch.enabled);
      changes.push(`status = $${values.length + 1}`);
      values.push(patch.enabled ? "active" : "disabled");
    }
    if (changes.length === 0) {
      return this.findByIdForUser(id, userId, tx);
    }
    changes.push(`updated_at = now()`);
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `UPDATE sources SET ${changes.join(", ")} WHERE id = $${values.length + 1} AND user_id = $${values.length + 2} AND deleted_at IS NULL RETURNING ${sourceColumns}`,
      [...values, id, userId],
    );
    return rows[0] ? mapSource(rows[0]) : null;
  }

  async softDelete(id: string, userId: string, tx?: TransactionClient): Promise<Source | null> {
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `UPDATE sources
       SET deleted_at = COALESCE(deleted_at, now()), enabled = false, status = 'disabled', updated_at = now()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING ${sourceColumns}`,
      [id, userId],
    );
    return rows[0] ? mapSource(rows[0]) : null;
  }

  async markCollectionSucceeded(id: string, fetchedAt: string, tx?: TransactionClient): Promise<Source | null> {
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `UPDATE sources
       SET status = 'active', last_fetched_at = $2, last_error_code = NULL,
           last_error_at = NULL, updated_at = $2
       WHERE id = $1 AND enabled = true AND deleted_at IS NULL
       RETURNING ${sourceColumns}`,
      [id, fetchedAt],
    );
    return rows[0] ? mapSource(rows[0]) : null;
  }

  async markCollectionFailed(id: string, errorCode: string, errorAt: string, tx?: TransactionClient): Promise<Source | null> {
    const rows = await queryRows<SourceRow>(
      this.executor(tx),
      `UPDATE sources
       SET status = 'error', last_error_code = $2, last_error_at = $3, updated_at = $3
       WHERE id = $1 AND enabled = true AND deleted_at IS NULL
       RETURNING ${sourceColumns}`,
      [id, errorCode, errorAt],
    );
    return rows[0] ? mapSource(rows[0]) : null;
  }
}

export class PostgresArticleRepository extends RepositoryBase implements ArticleRepository {
  /**
   * Inserts the Article and, in the same statement (transactional outbox),
   * an `article.created` outbox row that later triggers `process-article`.
   * The unique event_key guarantees one outbox row per Article.
   */
  async create(input: NewArticle, tx?: TransactionClient): Promise<Article> {
    const rows = await queryRows<ArticleRow>(
      this.executor(tx),
      `WITH inserted AS (
         INSERT INTO articles (
           source_id, external_id, canonical_url, original_url, original_title, original_language,
           original_excerpt, original_content, published_at, published_date_jst, discovered_at,
           processing_status, processing_error_code, late_arrival, missed_digest_cutoff
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, COALESCE($11, now()),
           COALESCE($12, 'pending'), $13, COALESCE($14, false), COALESCE($15, false)
         ) RETURNING *
       ), outbox AS (
         INSERT INTO outbox_events (event_key, event_type, aggregate_type, aggregate_id, payload)
         SELECT 'article.created:' || inserted.id, 'article.created', 'article', inserted.id,
                jsonb_build_object('articleId', inserted.id)
         FROM inserted
         WHERE inserted.processing_status = 'pending'
       )
       SELECT ${articleColumns} FROM inserted`,
      [
        input.sourceId,
        input.externalId ?? null,
        input.canonicalUrl ?? null,
        input.originalUrl,
        input.originalTitle,
        input.originalLanguage ?? null,
        input.originalExcerpt ?? null,
        input.originalContent ?? null,
        input.publishedAt ?? null,
        input.publishedDateJst ?? null,
        input.discoveredAt ?? null,
        input.processingStatus ?? null,
        input.processingErrorCode ?? null,
        input.lateArrival ?? null,
        input.missedDigestCutoff ?? null,
      ],
    );
    return mapArticle(first(rows, "Article insert returned no row."));
  }

  async findById(id: string, tx?: TransactionClient): Promise<Article | null> {
    const rows = await queryRows<ArticleRow>(
      this.executor(tx),
      `SELECT ${articleColumns} FROM articles WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapArticle(rows[0]) : null;
  }

  async listBySource(sourceId: string, tx?: TransactionClient): Promise<Article[]> {
    const rows = await queryRows<ArticleRow>(
      this.executor(tx),
      `SELECT ${articleColumns} FROM articles WHERE source_id = $1 ORDER BY discovered_at DESC, id`,
      [sourceId],
    );
    return rows.map(mapArticle);
  }

  async findBySourceAndCandidate(
    sourceId: string,
    candidate: { canonicalUrl?: string | null; externalId?: string | null; fingerprint?: string | null },
    tx?: TransactionClient,
  ): Promise<Article | null> {
    const rows = await queryRows<ArticleRow>(
      this.executor(tx),
      `SELECT ${articleColumns} FROM articles WHERE source_id = $1 AND (
        ($2::text IS NOT NULL AND canonical_url = $2) OR
        ($3::text IS NOT NULL AND external_id = $3) OR
        ($4::text IS NOT NULL AND md5(concat(original_title, '|', coalesce(original_excerpt, ''), '|', coalesce(canonical_url, original_url))) = $4)
      ) ORDER BY discovered_at DESC, id LIMIT 1`,
      [sourceId, candidate.canonicalUrl ?? null, candidate.externalId ?? null, candidate.fingerprint ?? null],
    );
    return rows[0] ? mapArticle(rows[0]) : null;
  }
}

export class PostgresEventRepository extends RepositoryBase implements EventRepository {
  async create(input: NewEvent, tx?: TransactionClient): Promise<Event> {
    const rows = await queryRows<EventRow>(
      this.executor(tx),
      `INSERT INTO events (
         user_id, title_vi, summary_vi, status, processing_status, first_seen_at, last_seen_at,
         prompt_version, model, provider
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${eventColumns}`,
      [
        input.userId,
        input.titleVi,
        input.summaryVi ?? null,
        input.status,
        input.processingStatus,
        input.firstSeenAt,
        input.lastSeenAt,
        input.promptVersion ?? null,
        input.model ?? null,
        input.provider ?? null,
      ],
    );
    return mapEvent(first(rows, "Event insert returned no row."));
  }

  async findByIdForUser(id: string, userId: string, tx?: TransactionClient): Promise<Event | null> {
    const rows = await queryRows<EventRow>(
      this.executor(tx),
      `SELECT ${eventColumns} FROM events WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] ? mapEvent(rows[0]) : null;
  }
}

export class PostgresEventArticleRepository extends RepositoryBase implements EventArticleRepository {
  async create(input: NewEventArticle, tx?: TransactionClient): Promise<EventArticle> {
    const rows = await queryRows<EventArticleRow>(
      this.executor(tx),
      `INSERT INTO event_articles (event_id, article_id, association_method)
       VALUES ($1, $2, $3) RETURNING ${eventArticleColumns}`,
      [input.eventId, input.articleId, input.associationMethod],
    );
    return mapEventArticle(first(rows, "Event/article insert returned no row."));
  }

  async listByEvent(eventId: string, tx?: TransactionClient): Promise<EventArticle[]> {
    const rows = await queryRows<EventArticleRow>(
      this.executor(tx),
      `SELECT ${eventArticleColumns} FROM event_articles WHERE event_id = $1 ORDER BY created_at, article_id`,
      [eventId],
    );
    return rows.map(mapEventArticle);
  }
}

export class PostgresDailyDigestRepository extends RepositoryBase implements DailyDigestRepository {
  async create(input: NewDailyDigest, tx?: TransactionClient): Promise<DailyDigest> {
    const rows = await queryRows<DailyDigestRow>(
      this.executor(tx),
      `INSERT INTO daily_digests (user_id, local_date, status, built_at, sent_at, failure_code)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${dailyDigestColumns}`,
      [input.userId, input.localDate, input.status, input.builtAt ?? null, input.sentAt ?? null, input.failureCode ?? null],
    );
    return mapDailyDigest(first(rows, "Daily digest insert returned no row."));
  }

  async findByUserAndDate(userId: string, localDate: string, tx?: TransactionClient): Promise<DailyDigest | null> {
    const rows = await queryRows<DailyDigestRow>(
      this.executor(tx),
      `SELECT ${dailyDigestColumns} FROM daily_digests WHERE user_id = $1 AND local_date = $2`,
      [userId, localDate],
    );
    return rows[0] ? mapDailyDigest(rows[0]) : null;
  }
}

export class PostgresDigestEventRepository extends RepositoryBase implements DigestEventRepository {
  async create(input: NewDigestEvent, tx?: TransactionClient): Promise<DigestEvent> {
    const rows = await queryRows<DigestEventRow>(
      this.executor(tx),
      `INSERT INTO digest_events (
         digest_id, event_id, position, title_vi_snapshot, summary_vi_snapshot,
         article_snapshot, source_snapshot
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
       RETURNING ${digestEventColumns}`,
      [
        input.digestId,
        input.eventId,
        input.position,
        input.titleViSnapshot,
        input.summaryViSnapshot,
        JSON.stringify(input.articleSnapshot),
        JSON.stringify(input.sourceSnapshot),
      ],
    );
    return mapDigestEvent(first(rows, "Digest event insert returned no row."));
  }

  async listByDigest(digestId: string, tx?: TransactionClient): Promise<DigestEvent[]> {
    const rows = await queryRows<DigestEventRow>(
      this.executor(tx),
      `SELECT ${digestEventColumns} FROM digest_events WHERE digest_id = $1 ORDER BY position`,
      [digestId],
    );
    return rows.map(mapDigestEvent);
  }
}

export class PostgresEmailDeliveryRepository extends RepositoryBase implements EmailDeliveryRepository {
  async create(input: NewEmailDelivery, tx?: TransactionClient): Promise<EmailDelivery> {
    const rows = await queryRows<EmailDeliveryRow>(
      this.executor(tx),
      `INSERT INTO email_deliveries (
         digest_id, provider, provider_message_id, idempotency_key, status, attempt_count,
         last_error_code, last_error_at, accepted_at, delivered_at
       ) VALUES (
         $1, $2, $3, $4, COALESCE($5, 'pending'), COALESCE($6, 0), $7, $8, $9, $10
       ) RETURNING ${emailDeliveryColumns}`,
      [
        input.digestId,
        input.provider ?? null,
        input.providerMessageId ?? null,
        input.idempotencyKey,
        input.status ?? null,
        input.attemptCount ?? null,
        input.lastErrorCode ?? null,
        input.lastErrorAt ?? null,
        input.acceptedAt ?? null,
        input.deliveredAt ?? null,
      ],
    );
    return mapEmailDelivery(first(rows, "Email delivery insert returned no row."));
  }

  async findByDigestId(digestId: string, tx?: TransactionClient): Promise<EmailDelivery | null> {
    const rows = await queryRows<EmailDeliveryRow>(
      this.executor(tx),
      `SELECT ${emailDeliveryColumns} FROM email_deliveries WHERE digest_id = $1`,
      [digestId],
    );
    return rows[0] ? mapEmailDelivery(rows[0]) : null;
  }
}

export class PostgresOutboxEventRepository extends RepositoryBase implements OutboxEventRepository {
  async create(input: NewOutboxEvent, tx: TransactionClient): Promise<OutboxEvent> {
    const rows = await queryRows<OutboxEventRow>(
      this.executor(tx),
      `INSERT INTO outbox_events (
         event_key, event_type, aggregate_type, aggregate_id, payload, status, attempt_count,
         available_at, processed_at, last_error_code
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb, COALESCE($6, 'pending'), COALESCE($7, 0),
         COALESCE($8, now()), $9, $10
       ) RETURNING ${outboxEventColumns}`,
      [
        input.eventKey,
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        JSON.stringify(input.payload),
        input.status ?? null,
        input.attemptCount ?? null,
        input.availableAt ?? null,
        input.processedAt ?? null,
        input.lastErrorCode ?? null,
      ],
    );
    return mapOutboxEvent(first(rows, "Outbox insert returned no row."));
  }

  async findByEventKey(eventKey: string, tx?: TransactionClient): Promise<OutboxEvent | null> {
    const rows = await queryRows<OutboxEventRow>(
      this.executor(tx),
      `SELECT ${outboxEventColumns} FROM outbox_events WHERE event_key = $1`,
      [eventKey],
    );
    return rows[0] ? mapOutboxEvent(rows[0]) : null;
  }
}

export class PostgresProcessingAttemptRepository extends RepositoryBase implements ProcessingAttemptRepository {
  async create(input: NewProcessingAttempt, tx?: TransactionClient): Promise<ProcessingAttempt> {
    const rows = await queryRows<ProcessingAttemptRow>(
      this.executor(tx),
      `INSERT INTO processing_attempts (
         entity_type, entity_id, operation, attempt_number, status, provider, model,
         prompt_version, error_code, started_at, finished_at, latency_ms, input_tokens,
         output_tokens, estimated_cost
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING ${processingAttemptColumns}`,
      [
        input.entityType,
        input.entityId,
        input.operation,
        input.attemptNumber,
        input.status,
        input.provider ?? null,
        input.model ?? null,
        input.promptVersion ?? null,
        input.errorCode ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        input.latencyMs ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.estimatedCost ?? null,
      ],
    );
    return mapProcessingAttempt(first(rows, "Processing attempt insert returned no row."));
  }

  async listByEntity(entityType: string, entityId: string, tx?: TransactionClient): Promise<ProcessingAttempt[]> {
    const rows = await queryRows<ProcessingAttemptRow>(
      this.executor(tx),
      `SELECT ${processingAttemptColumns}
       FROM processing_attempts WHERE entity_type = $1 AND entity_id = $2 ORDER BY created_at, id`,
      [entityType, entityId],
    );
    return rows.map(mapProcessingAttempt);
  }
}

export type PostgresRepositories = {
  transactions: PostgresTransactionManager;
  users: UserRepository;
  sessions: SessionRepository;
  userSettings: UserSettingsRepository;
  sources: SourceRepository;
  articles: ArticleRepository;
  events: EventRepository;
  eventArticles: EventArticleRepository;
  dailyDigests: DailyDigestRepository;
  digestEvents: DigestEventRepository;
  emailDeliveries: EmailDeliveryRepository;
  outboxEvents: OutboxEventRepository;
  processingAttempts: ProcessingAttemptRepository;
};

export function createPostgresRepositories(pool: Pool): PostgresRepositories {
  return {
    transactions: new PostgresTransactionManager(pool),
    users: new PostgresUserRepository(pool),
    sessions: new PostgresSessionRepository(pool),
    userSettings: new PostgresUserSettingsRepository(pool),
    sources: new PostgresSourceRepository(pool),
    articles: new PostgresArticleRepository(pool),
    events: new PostgresEventRepository(pool),
    eventArticles: new PostgresEventArticleRepository(pool),
    dailyDigests: new PostgresDailyDigestRepository(pool),
    digestEvents: new PostgresDigestEventRepository(pool),
    emailDeliveries: new PostgresEmailDeliveryRepository(pool),
    outboxEvents: new PostgresOutboxEventRepository(pool),
    processingAttempts: new PostgresProcessingAttemptRepository(pool),
  };
}

export class PostgresAuthStore implements AuthStore {
  private readonly repositories: PostgresRepositories;

  constructor(pool: Pool) {
    this.repositories = createPostgresRepositories(pool);
  }

  async createUser(input: { email: string; passwordHash: string; disabledAt?: string | null }): Promise<AppUser> {
    return this.repositories.users.create(input);
  }

  async createUserWithSettings(input: {
    email: string;
    passwordHash: string;
    recipientEmail: string;
    timezone: string;
    sendLocalTime: string;
  }): Promise<{ user: AppUser; settings: AppUserSettings }> {
    return this.repositories.transactions.transaction(async (tx) => {
      const user = await this.repositories.users.create(
        { email: input.email, passwordHash: input.passwordHash },
        tx,
      );
      const settings = await this.repositories.userSettings.upsert(
        {
          userId: user.id,
          recipientEmail: input.recipientEmail || user.email,
          timezone: input.timezone,
          sendLocalTime: input.sendLocalTime,
        },
        tx,
      );
      return { user, settings };
    });
  }

  async getUserById(id: string): Promise<AppUser | null> {
    return this.repositories.users.findById(id);
  }

  async getUserByEmail(email: string): Promise<AppUser | null> {
    return this.repositories.users.findByEmail(normalizeEmail(email));
  }

  async createSession(input: { userId: string }): Promise<AppSession> {
    const now = new Date();
    return this.repositories.sessions.create({
      id: randomUUID(),
      userId: input.userId,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: now.toISOString(),
    });
  }

  async getSession(id: string): Promise<AppSession | null> {
    return this.repositories.sessions.findById(id);
  }

  async updateSessionLastSeen(id: string): Promise<void> {
    await this.repositories.sessions.updateLastSeen(id);
  }

  async revokeSession(id: string): Promise<void> {
    await this.repositories.sessions.delete(id);
  }

  async revokeSessionsForUser(userId: string): Promise<void> {
    await this.repositories.sessions.deleteForUser(userId);
  }

  async getUserSettings(userId: string): Promise<AppUserSettings | null> {
    return this.repositories.userSettings.findByUserId(userId);
  }

  async createUserSettings(input: {
    userId: string;
    recipientEmail: string;
    timezone: string;
    sendLocalTime: string;
  }): Promise<AppUserSettings> {
    return this.repositories.userSettings.upsert(input);
  }
}
