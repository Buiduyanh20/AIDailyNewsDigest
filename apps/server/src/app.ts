import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";

import {
  loginRequestSchema,
  loginResponseSchema,
  sessionResponseSchema,
  logoutResponseSchema,
  sourceCreateSchema,
  sourceUpdateSchema,
  sourceListResponseSchema,
  sourceRetryResponseSchema,
  eventListQuerySchema,
  eventListResponseSchema,
  eventDetailResponseSchema,
  articleRetryResponseSchema,
  settingsResponseSchema,
  digestListResponseSchema,
  digestDetailResponseSchema,
  digestPreviewResponseSchema,
  dashboardSummarySchema,
} from "@aidnd/contracts";

import { AuthService, SESSION_COOKIE_NAME, buildCsrfCookieOptions, buildSessionCookieOptions, generateCsrfToken, requireAuth } from "./auth/service.js";
import { clearAuthCookies, validateCsrf } from "./auth/csrf.js";
import { createAuthStore, type AuthStore } from "./db/auth-store.js";
import { environment } from "./config/env.js";
import { AppError, NotFoundError, UnauthorizedError, ValidationError, toApiError } from "./errors/index.js";
import { createMemoryEventService, type EventService } from "./events/service.js";
import { createMemoryDigestApi, type DigestApi } from "./digest/service.js";
import { mapResendEvent, verifyResendWebhook } from "./email/resend-provider.js";
import { SettingsService } from "./settings/service.js";
import { createRuntimeSourceService, type SourceService } from "./sources/service.js";

export type ResendWebhookHandler = {
  secret: string | undefined;
  apply(input: {
    webhookId: string;
    eventType: string;
    providerMessageId: string;
    status: "accepted" | "delivered" | "failed";
  }): Promise<"applied" | "duplicate" | "unknown_message">;
};

export type CronTriggerHandler = {
  /** CRON_TRIGGER_TOKEN; when unset the endpoint answers 404 (disabled). */
  token: string | undefined;
  trigger(): Promise<{ localDate: string; operations: Array<{ operation: string; jobId: string | null }> }>;
};

/** Constant-time Bearer check (hashing first makes the comparison length-independent). */
export function isAuthorizedCronRequest(authorization: string | undefined, token: string): boolean {
  const match = /^Bearer (\S+)$/.exec(authorization?.trim() ?? "");
  if (!match?.[1]) return false;
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(match[1]), digest(token));
}

const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export function buildApp(options: {
  authStore?: AuthStore;
  readinessCheck?: () => Promise<boolean>;
  sourceService?: SourceService;
  eventService?: EventService;
  digestApi?: DigestApi;
  resendWebhook?: ResendWebhookHandler;
  cronTrigger?: CronTriggerHandler;
  /** Built web app (apps/web/dist) to serve from this process; production single-container mode. */
  webDistDir?: string;
} = {}) {
  const app = Fastify({ logger: false });
  const authStore = options.authStore ?? createAuthStore();
  const authService = new AuthService(authStore);
  const settingsService = new SettingsService(authStore);
  const sourceService = options.sourceService ?? createRuntimeSourceService();
  const eventService = options.eventService ?? createMemoryEventService();
  const digestApi = options.digestApi ?? createMemoryDigestApi();

  app.register(cookie);
  app.register(cors, {
    origin: environment.corsOrigin,
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
  });
  app.register(rateLimit, {
    global: false,
    keyGenerator: (request) => {
      const forwardedFor = request.headers["x-forwarded-for"];
      if (typeof forwardedFor === "string") {
        return forwardedFor.split(",")[0].trim() || request.ip || "anonymous";
      }
      return request.ip || "anonymous";
    },
    errorResponseBuilder: () => ({
      statusCode: 429,
      error: "Too Many Requests",
      message: "Too many login attempts. Please try again later.",
    }),
  });

  app.setErrorHandler((error, request, reply) => {
    if (!(error instanceof AppError) || error.statusCode >= 500) {
      // Structured, header-free (no cookies/Authorization) and never sent to the client.
      console.error(
        JSON.stringify({
          level: "error",
          msg: "request failed",
          method: request.method,
          route: request.routeOptions?.url ?? null,
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorCode: error instanceof AppError ? error.code : ((error as { code?: unknown }).code ?? null),
          message: error instanceof Error ? error.message : null,
        }),
      );
    }

    const mapped = toApiError(error);
    reply.code(mapped.statusCode).send(mapped.body);
  });

  // Production single container: the API process also serves the built React app.
  const webDistDir = options.webDistDir && existsSync(join(options.webDistDir, "index.html")) ? options.webDistDir : undefined;
  if (webDistDir) {
    app.register(fastifyStatic, {
      root: webDistDir,
      index: "index.html",
      setHeaders: (response, filePath) => {
        // Vite emits content-hashed files under assets/; everything else must revalidate.
        response.header("Cache-Control", /[\\/]assets[\\/]/.test(filePath) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split("?")[0] ?? "";
    const isApiPath = path.startsWith("/api/") || path === "/api" || path === "/health" || path === "/ready";
    if (webDistDir && (request.method === "GET" || request.method === "HEAD") && !isApiPath) {
      // Client-side routes (/digests/:id, ...) load the SPA shell.
      reply.header("Cache-Control", "no-cache");
      return reply.sendFile("index.html");
    }
    const mapped = toApiError(new NotFoundError());
    return reply.code(mapped.statusCode).send(mapped.body);
  });

  app.get("/health", async () => ({ status: "ok" as const }));
  app.get("/ready", async (_request, reply) => {
    const ready = options.readinessCheck ? await options.readinessCheck() : true;
    if (!ready) {
      reply.code(503);
      return { status: "not_ready" as const };
    }
    return { status: "ready" as const };
  });

  app.get("/api/v1/auth/csrf", async (_request: FastifyRequest, reply: FastifyReply) => {
    const token = generateCsrfToken();
    reply.setCookie("aidnd_csrf", token, buildCsrfCookieOptions(environment.nodeEnv === "production"));
    return { token };
  });

  app.post(
    "/api/v1/auth/login",
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 15 * 60 * 1000,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "Invalid email or password." });
        return;
      }

      if (!validateCsrf(request, reply)) {
        return;
      }

      const { email, password } = parsed.data;
      if (authService.isLoginRateLimited(email)) {
        reply.code(429).send({ error: "Too many login attempts. Please try again later." });
        return;
      }

      const user = await authService.authenticate(email, password);
      if (!user) {
        authService.recordFailedLogin(email);
        reply.code(401).send({ error: "Invalid email or password." });
        return;
      }

      authService.clearFailedLogin(email);

      const session = await authService.createSession(user.id);
      reply.setCookie(SESSION_COOKIE_NAME, session.id, buildSessionCookieOptions(environment.nodeEnv === "production"));
      reply.clearCookie("aidnd_csrf", { path: "/" });

      const response = {
        user: { id: user.id, email: user.email },
      };
      loginResponseSchema.parse(response);
      return response;
    },
  );

  app.get("/api/v1/auth/session", async (request: FastifyRequest, reply: FastifyReply) => {
    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) {
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    const user = await authService.getSessionUser(sessionId);
    if (!user) {
      clearAuthCookies(reply);
      reply.code(401).send({ error: "Unauthorized" });
      return;
    }

    const response = {
      user: { id: user.id, email: user.email },
    };
    sessionResponseSchema.parse(response);
    return response;
  });

  app.post("/api/v1/auth/logout", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!validateCsrf(request, reply)) {
      return;
    }

    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];
    if (sessionId) {
      await authService.logout(sessionId);
    }

    clearAuthCookies(reply);
    const response = { success: true };
    logoutResponseSchema.parse(response);
    return response;
  });

  app.get(
    "/api/v1/sources",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }

      const page = Number((request.query as { page?: string })?.page ?? 1);
      const pageSize = Number((request.query as { pageSize?: string })?.pageSize ?? 20);
      const status = (request.query as { status?: string })?.status as "active" | "disabled" | "error" | undefined;
      const search = (request.query as { search?: string })?.search;
      const result = await sourceService.listSources(user.id, { page, pageSize, status, search });
      const response = {
        items: result.items.map((source) => ({
          id: source.id,
          userId: source.userId,
          name: source.name,
          websiteUrl: source.websiteUrl,
          rssUrl: source.rssUrl,
          enabled: source.enabled,
          status: source.status,
          lastFetchedAt: source.lastFetchedAt,
          lastErrorCode: source.lastErrorCode,
          lastErrorAt: source.lastErrorAt,
          createdAt: source.createdAt,
          updatedAt: source.updatedAt,
        })),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
      };
      sourceListResponseSchema.parse(response);
      return response;
    },
  );

  app.post(
    "/api/v1/sources",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      if (!validateCsrf(request, reply)) {
        return;
      }
      const parsed = sourceCreateSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "Invalid source payload." });
        return;
      }

      const source = await sourceService.createSource(user.id, parsed.data);
      return {
        id: source.id,
        userId: source.userId,
        name: source.name,
        websiteUrl: source.websiteUrl,
        rssUrl: source.rssUrl,
        enabled: source.enabled,
        status: source.status,
        lastFetchedAt: source.lastFetchedAt,
        lastErrorCode: source.lastErrorCode,
        lastErrorAt: source.lastErrorAt,
        deletedAt: source.deletedAt,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      };
    },
  );

  app.get(
    "/api/v1/sources/:sourceId",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      const sourceId = (request.params as { sourceId: string }).sourceId;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const result = await sourceService.getSourceForUser(user.id, sourceId);
      return {
        ...result.source,
        recentArticles: result.recentArticles.map((article) => ({
          id: article.id,
          sourceId: article.sourceId,
          originalTitle: article.originalTitle,
          originalUrl: article.originalUrl,
          publishedAt: article.publishedAt,
          publishedDateJst: article.publishedDateJst,
          discoveredAt: article.discoveredAt,
          processingStatus: article.processingStatus,
          lateArrival: article.lateArrival,
          createdAt: article.createdAt,
        })),
      };
    },
  );

  app.patch(
    "/api/v1/sources/:sourceId",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      const sourceId = (request.params as { sourceId: string }).sourceId;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      if (!validateCsrf(request, reply)) {
        return;
      }
      const parsed = sourceUpdateSchema.safeParse(request.body);
      if (!parsed.success) {
        reply.code(400).send({ error: "Invalid source update." });
        return;
      }
      const source = await sourceService.updateSourceForUser(user.id, sourceId, parsed.data);
      return source;
    },
  );

  app.delete(
    "/api/v1/sources/:sourceId",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      const sourceId = (request.params as { sourceId: string }).sourceId;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      if (!validateCsrf(request, reply)) {
        return;
      }
      const source = await sourceService.deleteSourceForUser(user.id, sourceId);
      return { deleted: true, source };
    },
  );

  app.post(
    "/api/v1/sources/:sourceId/retry",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      const sourceId = (request.params as { sourceId: string }).sourceId;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      if (!validateCsrf(request, reply)) {
        return;
      }
      const result = await sourceService.retrySource(user.id, sourceId);
      sourceRetryResponseSchema.parse(result);
      return result;
    },
  );

  app.get(
    "/api/v1/articles",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const sources = await sourceService.listSources(user.id, { page: 1, pageSize: 100 });
      const articles: unknown[] = [];
      for (const source of sources.items) {
        const result = await sourceService.getSourceForUser(user.id, source.id);
        articles.push(...result.recentArticles);
      }
      return { items: articles.slice(0, 20), page: 1, pageSize: 20, total: articles.length };
    },
  );

  app.get(
    "/api/v1/events",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const query = eventListQuerySchema.safeParse(request.query ?? {});
      if (!query.success) {
        throw new ValidationError("The event filters are invalid.");
      }
      const response = await eventService.listEvents(user.id, query.data);
      return eventListResponseSchema.parse(response);
    },
  );

  app.get(
    "/api/v1/events/:eventId",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const eventId = (request.params as { eventId: string }).eventId;
      const response = await eventService.getEvent(user.id, eventId);
      return eventDetailResponseSchema.parse(response);
    },
  );

  app.post(
    "/api/v1/articles/:articleId/retry",
    {
      preHandler: [requireAuth(authService)],
      config: { rateLimit: { max: 30, timeWindow: 60 * 1000 } },
    },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      if (!validateCsrf(request, reply)) {
        return;
      }
      const articleId = (request.params as { articleId: string }).articleId;
      const result = await eventService.retryArticle(user.id, articleId);
      return articleRetryResponseSchema.parse(result);
    },
  );

  // ------------------------------------------------------------ Phase 6: Settings

  app.get(
    "/api/v1/settings",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      if (!request.user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      return settingsResponseSchema.parse(await settingsService.get(request.user));
    },
  );

  app.patch(
    "/api/v1/settings",
    { preHandler: [requireAuth(authService)], config: { rateLimit: { max: 30, timeWindow: 60 * 1000 } } },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      if (!request.user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      if (!validateCsrf(request, reply)) {
        return;
      }
      return settingsResponseSchema.parse(await settingsService.updateRecipient(request.user.id, request.body));
    },
  );

  // ------------------------------------------------------------ Phase 6: Daily Digest

  app.get(
    "/api/v1/digests",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      if (!request.user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const query = pageQuerySchema.safeParse(request.query ?? {});
      if (!query.success) throw new ValidationError("The pagination parameters are invalid.");
      return digestListResponseSchema.parse(await digestApi.list(request.user.id, query.data.page, query.data.pageSize));
    },
  );

  app.get(
    "/api/v1/digests/:digestId",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      if (!request.user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const { digestId } = request.params as { digestId: string };
      return digestDetailResponseSchema.parse(await digestApi.detail(request.user.id, digestId));
    },
  );

  app.get(
    "/api/v1/digests/:digestId/preview",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      if (!request.user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      const { digestId } = request.params as { digestId: string };
      return digestPreviewResponseSchema.parse(await digestApi.preview(request.user.id, digestId));
    },
  );

  app.get(
    "/api/v1/dashboard/summary",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      if (!request.user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }
      return dashboardSummarySchema.parse(await digestApi.dashboard(request.user.id));
    },
  );

  // Resend delivery webhook: authenticated by Svix signature (no session/CSRF), raw body required.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));
    scope.post("/api/v1/webhooks/resend", async (request: FastifyRequest, reply: FastifyReply) => {
      const handler = options.resendWebhook;
      if (!handler?.secret) {
        throw new NotFoundError();
      }
      const raw = typeof request.body === "string" ? request.body : "";
      const header = (name: string) => {
        const value = request.headers[name];
        return typeof value === "string" ? value : undefined;
      };
      const webhookId = header("svix-id");
      const verified = verifyResendWebhook(
        handler.secret,
        { id: webhookId, timestamp: header("svix-timestamp"), signature: header("svix-signature") },
        raw,
      );
      if (!verified || !webhookId) {
        reply.code(401).send({ error: { code: "UNAUTHORIZED", message: "Invalid webhook signature." } });
        return;
      }
      let event: { type?: string; data?: { email_id?: string } };
      try {
        event = JSON.parse(raw) as typeof event;
      } catch {
        throw new ValidationError("The webhook payload is invalid.");
      }
      const status = mapResendEvent(event.type);
      const messageId = event.data?.email_id;
      if (!status || status === "not_found" || !messageId || !event.type) {
        return { received: true, applied: false };
      }
      const result = await handler.apply({ webhookId, eventType: event.type, providerMessageId: messageId, status });
      return { received: true, applied: result === "applied" };
    });
  });

  // Cron-job.org trigger: Bearer CRON_TRIGGER_TOKEN (no browser session/CSRF). Enqueues the due
  // tick jobs and returns 202 immediately; the request body is ignored (any content type).
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, _payload, done) => done(null, undefined));
    scope.post("/api/v1/internal/cron/daily-digest", async (request: FastifyRequest, reply: FastifyReply) => {
      const handler = options.cronTrigger;
      if (!handler?.token) {
        throw new NotFoundError();
      }
      // The Authorization header is never logged or echoed.
      if (!isAuthorizedCronRequest(request.headers.authorization, handler.token)) {
        reply.header("WWW-Authenticate", "Bearer");
        throw new UnauthorizedError("A valid cron trigger token is required.");
      }
      const result = await handler.trigger();
      reply.code(202);
      return { status: "accepted" as const, localDate: result.localDate, jobs: result.operations };
    });
  });

  app.get(
    "/api/v1/protected",
    { preHandler: [requireAuth(authService)] },
    async (request: FastifyRequest & { user?: { id: string; email: string } }, reply: FastifyReply) => {
      const user = request.user;
      if (!user) {
        reply.code(401).send({ error: "Unauthorized" });
        return;
      }

      return { ok: true, user: { id: user.id, email: user.email } };
    },
  );

  return app;
}
