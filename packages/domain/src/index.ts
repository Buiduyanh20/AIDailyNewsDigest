export type User = {
  id: string;
  email: string;
  passwordHash: string;
  disabledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Session = {
  id: string;
  userId: string;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
};

export type UserSettings = {
  userId: string;
  recipientEmail: string;
  timezone: string;
  sendLocalTime: string;
  createdAt: string;
  updatedAt: string;
};

export type SourceStatus = "active" | "disabled" | "error";

export type Source = {
  id: string;
  userId: string;
  name: string;
  websiteUrl: string;
  rssUrl: string | null;
  enabled: boolean;
  status: SourceStatus;
  lastFetchedAt: string | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Article = {
  id: string;
  sourceId: string;
  externalId: string | null;
  canonicalUrl: string | null;
  originalUrl: string;
  originalTitle: string;
  originalLanguage: string | null;
  originalExcerpt: string | null;
  originalContent: string | null;
  publishedAt: string | null;
  publishedDateJst: string | null;
  discoveredAt: string;
  processingStatus: string;
  processingErrorCode: string | null;
  lateArrival: boolean;
  missedDigestCutoff: boolean;
  createdAt: string;
  updatedAt: string;
};

export type Event = {
  id: string;
  userId: string;
  titleVi: string;
  summaryVi: string | null;
  status: string;
  processingStatus: string;
  firstSeenAt: string;
  lastSeenAt: string;
  promptVersion: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
};

export type EventArticle = {
  eventId: string;
  articleId: string;
  associationMethod: string;
  createdAt: string;
};

export type DailyDigestStatus = "scheduled" | "building" | "ready" | "sending" | "sent" | "failed";

export type DailyDigest = {
  id: string;
  userId: string;
  localDate: string;
  status: DailyDigestStatus;
  builtAt: string | null;
  sentAt: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DigestArticleSnapshot = {
  articleId: string;
  sourceId: string;
  originalTitle: string;
  originalUrl: string;
  /** Snapshotted so a sent Digest renders without reading current Source/Article rows. */
  sourceName?: string;
  publishedAt?: string | null;
};

export type DigestSourceSnapshot = {
  sourceId: string;
  name: string;
  websiteUrl: string;
  rssUrl: string | null;
};

export type DigestEvent = {
  digestId: string;
  eventId: string;
  position: number;
  titleViSnapshot: string;
  summaryViSnapshot: string;
  articleSnapshot: DigestArticleSnapshot[];
  sourceSnapshot: DigestSourceSnapshot[];
  createdAt: string;
};

export type EmailDeliveryStatus = "pending" | "sending" | "accepted" | "delivered" | "failed" | "unknown";

export type EmailDelivery = {
  id: string;
  digestId: string;
  provider: string | null;
  providerMessageId: string | null;
  idempotencyKey: string;
  status: EmailDeliveryStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  acceptedAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type OutboxEvent = {
  id: string;
  eventKey: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: JsonValue;
  status: string;
  attemptCount: number;
  availableAt: string;
  processedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ProcessingAttempt = {
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
  startedAt: string | null;
  finishedAt: string | null;
  latencyMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCost: string | null;
  createdAt: string;
};

export * from "./events.js";
export * from "./digest.js";
export * from "./language.js";
