import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const userPublicSchema = z.object({
  id: z.string().uuid().or(z.string().min(1)),
  email: z.string().email(),
});

export const loginRequestSchema = z.object({
  email: z.string().trim().min(1).max(254).email(),
  password: z.string().min(8).max(256),
});

export const loginResponseSchema = z.object({
  user: userPublicSchema,
});

export const sessionResponseSchema = z.object({
  user: userPublicSchema,
});

export const logoutResponseSchema = z.object({
  success: z.boolean(),
});

export const authErrorSchema = z.object({
  error: z.string(),
});

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export const sourceStatusSchema = z.enum(["active", "disabled", "error"]);
export const sourceSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  name: z.string().min(1),
  websiteUrl: z.string().url(),
  rssUrl: z.string().url().nullable(),
  enabled: z.boolean(),
  status: sourceStatusSchema,
  lastFetchedAt: timestampSchema.nullable(),
  lastErrorCode: z.string().nullable(),
  lastErrorAt: timestampSchema.nullable(),
  deletedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const sourceCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  websiteUrl: z.string().url(),
  rssUrl: z.string().url().nullable().optional(),
  enabled: z.boolean().optional().default(true),
});

export const sourceUpdateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  websiteUrl: z.string().url().optional(),
  rssUrl: z.string().url().nullable().optional(),
  enabled: z.boolean().optional(),
});

export const sourceListItemSchema = sourceSchema.pick({
  id: true,
  name: true,
  websiteUrl: true,
  rssUrl: true,
  enabled: true,
  status: true,
  lastFetchedAt: true,
  lastErrorCode: true,
  lastErrorAt: true,
  createdAt: true,
  updatedAt: true,
});

export const sourceListResponseSchema = z.object({
  items: z.array(sourceListItemSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});

export const sourceRetryResponseSchema = z.object({
  jobId: z.string().min(1),
  status: z.literal("queued"),
});

export const articleSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  externalId: z.string().nullable(),
  canonicalUrl: z.string().url().nullable(),
  originalUrl: z.string().url(),
  originalTitle: z.string().min(1),
  originalLanguage: z.string().nullable(),
  originalExcerpt: z.string().nullable(),
  originalContent: z.string().nullable(),
  publishedAt: timestampSchema.nullable(),
  publishedDateJst: localDateSchema.nullable(),
  discoveredAt: timestampSchema,
  processingStatus: z.string().min(1),
  processingErrorCode: z.string().nullable(),
  lateArrival: z.boolean(),
  missedDigestCutoff: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const articleListItemSchema = articleSchema.pick({
  id: true,
  sourceId: true,
  originalTitle: true,
  originalUrl: true,
  publishedAt: true,
  publishedDateJst: true,
  discoveredAt: true,
  processingStatus: true,
  lateArrival: true,
  createdAt: true,
});

export const articleListResponseSchema = z.object({
  items: z.array(articleListItemSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});

export const eventSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  titleVi: z.string(),
  summaryVi: z.string().nullable(),
  status: z.string().min(1),
  processingStatus: z.string().min(1),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
  promptVersion: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

// ---------------------------------------------------------------------------
// Phase 5 — News & Events API
// ---------------------------------------------------------------------------

export const eventListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  date: localDateSchema.optional(),
  sourceId: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sort: z.literal("latest").default("latest"),
});

export const eventSourceRefSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
});

export const eventListItemSchema = z.object({
  id: z.string().uuid(),
  titleVi: z.string(),
  summaryVi: z.string().nullable(),
  processingStatus: z.string().min(1),
  firstSeenAt: timestampSchema,
  lastSeenAt: timestampSchema,
  latestArticleAt: timestampSchema,
  articleCount: z.number().int().nonnegative(),
  sources: z.array(eventSourceRefSchema),
});

export const eventListResponseSchema = z.object({
  items: z.array(eventListItemSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});

export const eventArticleSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceName: z.string(),
  originalTitle: z.string(),
  originalUrl: z.string().url(),
  originalLanguage: z.string().nullable(),
  publishedAt: timestampSchema.nullable(),
  publishedDateJst: localDateSchema.nullable(),
  discoveredAt: timestampSchema,
});

export const eventDetailResponseSchema = eventListItemSchema.extend({
  sources: z.array(eventSourceRefSchema.extend({ websiteUrl: z.string().url() })),
  articles: z.array(eventArticleSchema),
});

export const articleRetryResponseSchema = z.object({
  jobId: z.string().min(1),
  status: z.literal("queued"),
});

export const dailyDigestStatusSchema = z.enum(["scheduled", "building", "ready", "sending", "sent", "failed"]);
export const dailyDigestSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  localDate: localDateSchema,
  status: dailyDigestStatusSchema,
  builtAt: timestampSchema.nullable(),
  sentAt: timestampSchema.nullable(),
  failureCode: z.string().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const digestArticleSnapshotSchema = z.object({
  articleId: z.string().uuid(),
  sourceId: z.string().uuid(),
  originalTitle: z.string(),
  originalUrl: z.string().url(),
  sourceName: z.string().optional(),
  publishedAt: timestampSchema.nullable().optional(),
});

export const digestSourceSnapshotSchema = z.object({
  sourceId: z.string().uuid(),
  name: z.string(),
  websiteUrl: z.string().url(),
  rssUrl: z.string().url().nullable(),
});

export const digestEventSchema = z.object({
  digestId: z.string().uuid(),
  eventId: z.string().uuid(),
  position: z.number().int().positive(),
  titleViSnapshot: z.string(),
  summaryViSnapshot: z.string(),
  articleSnapshot: z.array(digestArticleSnapshotSchema),
  sourceSnapshot: z.array(digestSourceSnapshotSchema),
  createdAt: timestampSchema,
});

export const emailDeliveryStatusSchema = z.enum(["pending", "sending", "accepted", "delivered", "failed", "unknown"]);
export const emailDeliverySchema = z.object({
  id: z.string().uuid(),
  digestId: z.string().uuid(),
  provider: z.string().nullable(),
  providerMessageId: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  status: emailDeliveryStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastErrorCode: z.string().nullable(),
  lastErrorAt: timestampSchema.nullable(),
  acceptedAt: timestampSchema.nullable(),
  deliveredAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

// ---------------------------------------------------------------------------
// Phase 6 — Settings, Daily Digest, Dashboard
// ---------------------------------------------------------------------------

export const settingsResponseSchema = z.object({
  recipientEmail: z.string().email(),
  timezone: z.literal("Asia/Tokyo"),
  sendLocalTime: z.literal("07:00"),
});

/** Only the recipient is editable; timezone and send time are product constants. */
export const settingsUpdateSchema = z
  .object({
    recipientEmail: z.string().trim().min(1, "Recipient email is required.").max(254).email("Enter a valid email address."),
  })
  .strict();

export const digestSummarySchema = z.object({
  id: z.string().uuid(),
  localDate: localDateSchema,
  status: dailyDigestStatusSchema,
  subject: z.string(),
  eventCount: z.number().int().nonnegative(),
  isEmpty: z.boolean(),
  builtAt: timestampSchema.nullable(),
  sentAt: timestampSchema.nullable(),
  deliveryStatus: emailDeliveryStatusSchema.nullable(),
});

export const digestListResponseSchema = z.object({
  items: z.array(digestSummarySchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});

export const digestSnapshotEventSchema = z.object({
  eventId: z.string().uuid(),
  position: z.number().int().positive(),
  titleVi: z.string(),
  summaryVi: z.string(),
  sources: z.array(z.string()),
  articles: z.array(
    z.object({
      articleId: z.string().uuid(),
      sourceName: z.string(),
      originalTitle: z.string(),
      originalUrl: z.string().url(),
      publishedAt: timestampSchema.nullable(),
    }),
  ),
});

export const digestDetailResponseSchema = digestSummarySchema.extend({
  displayDate: z.string(),
  events: z.array(digestSnapshotEventSchema),
});

export const digestPreviewResponseSchema = z.object({
  id: z.string().uuid(),
  localDate: localDateSchema,
  displayDate: z.string(),
  subject: z.string(),
  isEmpty: z.boolean(),
  eventCount: z.number().int().nonnegative(),
  events: z.array(digestSnapshotEventSchema),
  /** Exactly the HTML body the email uses (rendered from the same snapshot). */
  html: z.string(),
});

export const dashboardSummarySchema = z.object({
  activeSources: z.number().int().nonnegative(),
  articlesCollected: z.number().int().nonnegative(),
  eventsDetected: z.number().int().nonnegative(),
  latestDigest: digestSummarySchema.nullable(),
  nextDigest: z.object({ localDate: localDateSchema, sendAt: timestampSchema }),
});

export type SettingsResponse = z.infer<typeof settingsResponseSchema>;
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export type DigestSummary = z.infer<typeof digestSummarySchema>;
export type DigestListResponse = z.infer<typeof digestListResponseSchema>;
export type DigestSnapshotEvent = z.infer<typeof digestSnapshotEventSchema>;
export type DigestDetailResponse = z.infer<typeof digestDetailResponseSchema>;
export type DigestPreviewResponse = z.infer<typeof digestPreviewResponseSchema>;
export type DashboardSummary = z.infer<typeof dashboardSummarySchema>;

export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type LoginResponse = z.infer<typeof loginResponseSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
export type AuthError = z.infer<typeof authErrorSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type SourceContract = z.infer<typeof sourceSchema>;
export type ArticleContract = z.infer<typeof articleSchema>;
export type EventContract = z.infer<typeof eventSchema>;
export type EventListQuery = z.infer<typeof eventListQuerySchema>;
export type EventListItem = z.infer<typeof eventListItemSchema>;
export type EventListResponse = z.infer<typeof eventListResponseSchema>;
export type EventArticleContract = z.infer<typeof eventArticleSchema>;
export type EventDetailResponse = z.infer<typeof eventDetailResponseSchema>;
export type ArticleRetryResponse = z.infer<typeof articleRetryResponseSchema>;
export type DailyDigestContract = z.infer<typeof dailyDigestSchema>;
export type DigestEventContract = z.infer<typeof digestEventSchema>;
export type EmailDeliveryContract = z.infer<typeof emailDeliverySchema>;
