import { config } from "dotenv";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV !== "test") {
  config({ path: fileURLToPath(new URL("../../../../.env", import.meta.url)) });
}

export type Environment = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string | undefined;
  /** Max connections of the application pool (Neon free tier: keep small). */
  databasePoolMax: number;
  sessionSecret: string;
  corsOrigin: string;
  adminEmail: string | undefined;
  adminPassword: string | undefined;
  sessionCookieName: string;
  ai: AiEnvironment;
  email: EmailEnvironment;
  digest: DigestEnvironment;
  /** Built web app served by the API process in production (single container). Unset = not served. */
  webDistDir: string | undefined;
};

/**
 * Server-side email configuration. Resend is the only supported provider in
 * the MVP. The API key and webhook secret are only handed to the adapter and
 * must never be logged, returned by the API, or bundled into the web app.
 */
export type EmailEnvironment = {
  provider: "resend" | undefined;
  resendApiKey: string | undefined;
  resendWebhookSecret: string | undefined;
  from: string | undefined;
  requestTimeoutMs: number;
};

export type DigestEnvironment = {
  /** Set DIGEST_SCHEDULER_ENABLED=false to run the server without the 05:30/06:00/06:45 JST jobs. */
  schedulerEnabled: boolean;
  /**
   * Bearer token for POST /api/v1/internal/cron/daily-digest (Cron-job.org). Unset = endpoint
   * disabled (404). Server-side only: never logged, returned, or bundled into the web app.
   */
  cronTriggerToken: string | undefined;
};

/** Minimum Cron token length (e.g. `openssl rand -hex 32` gives 64 characters). */
export const MIN_CRON_TOKEN_LENGTH = 32;

export function parseCronTriggerToken(value: string | undefined): string | undefined {
  const token = value?.trim() || undefined;
  if (token !== undefined && token.length < MIN_CRON_TOKEN_LENGTH) {
    throw new Error(`CRON_TRIGGER_TOKEN must be at least ${MIN_CRON_TOKEN_LENGTH} characters.`);
  }
  return token;
}

export function parseEmailEnvironment(env: NodeJS.ProcessEnv): EmailEnvironment {
  const provider = env.EMAIL_PROVIDER?.trim().toLowerCase() || undefined;
  if (provider !== undefined && provider !== "resend") {
    throw new Error("EMAIL_PROVIDER must be \"resend\" (the only supported email provider).");
  }
  return {
    provider,
    // RESEND_API_KEY is canonical; EMAIL_API_KEY (the earlier reserved name) is accepted as a fallback.
    resendApiKey: env.RESEND_API_KEY?.trim() || env.EMAIL_API_KEY?.trim() || undefined,
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET?.trim() || undefined,
    from: env.EMAIL_FROM?.trim() || undefined,
    requestTimeoutMs: positiveInteger(env.EMAIL_TIMEOUT_MS, 15_000, "EMAIL_TIMEOUT_MS"),
  };
}

/**
 * Server-side AI configuration. The API key is only ever read here and handed
 * to the provider adapter; it must never be logged, returned by the API, or
 * bundled into the web app.
 */
export type AiEnvironment = {
  geminiApiKey: string | undefined;
  geminiModel: string;
  requestTimeoutMs: number;
  candidateWindowHours: number;
  maxCandidates: number;
};

/**
 * Single default location for the Gemini model; override with GEMINI_MODEL.
 * gemini-2.5-* models return 404 "no longer available to new users"; Google
 * recommends gemini-3.5-flash-lite as the replacement. Use the bare model id
 * (no "models/" prefix) — the adapter builds the "models/{id}" path itself.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseAiEnvironment(env: NodeJS.ProcessEnv): AiEnvironment {
  return {
    geminiApiKey: env.GEMINI_API_KEY?.trim() || undefined,
    geminiModel: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
    requestTimeoutMs: positiveInteger(env.GEMINI_TIMEOUT_MS, 30_000, "GEMINI_TIMEOUT_MS"),
    candidateWindowHours: positiveInteger(env.AI_CANDIDATE_WINDOW_HOURS, 72, "AI_CANDIDATE_WINDOW_HOURS"),
    maxCandidates: positiveInteger(env.AI_MAX_CANDIDATES, 8, "AI_MAX_CANDIDATES"),
  };
}

export function parseEnvironment(env: NodeJS.ProcessEnv): Environment {
  const nodeEnv = (env.NODE_ENV ?? "development") as Environment["nodeEnv"];
  if (nodeEnv !== "development" && nodeEnv !== "test" && nodeEnv !== "production") {
    throw new Error("NODE_ENV must be development, test, or production.");
  }

  // Production listens on the platform-provided PORT (Render sets it); 3000 is the local default only.
  if (nodeEnv === "production" && !env.PORT?.trim()) {
    throw new Error("PORT is required in production (Render provides it).");
  }
  const port = Number(env.PORT?.trim() || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }

  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (nodeEnv !== "test" && !databaseUrl) {
    throw new Error("DATABASE_URL is required in development and production. Configure PostgreSQL before starting the server.");
  }

  const sessionSecret = env.SESSION_SECRET?.trim();
  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required in all environments.");
  }

  const corsOrigin = env.CORS_ORIGIN?.trim() || (nodeEnv === "production" ? "" : "http://localhost:5173");
  if (nodeEnv === "production" && !/^https:\/\/[^\s/*]+$/.test(corsOrigin)) {
    throw new Error("CORS_ORIGIN must be the exact https origin in production (for example https://digest.buiduyanh.io.vn); '*' and http are not allowed.");
  }

  const databasePoolMax = Number(env.DATABASE_POOL_MAX?.trim() || 10);
  if (!Number.isInteger(databasePoolMax) || databasePoolMax < 1 || databasePoolMax > 100) {
    throw new Error("DATABASE_POOL_MAX must be an integer between 1 and 100.");
  }
  const adminEmail = env.ADMIN_EMAIL?.trim() || undefined;
  const adminPassword = env.ADMIN_PASSWORD?.trim() || undefined;

  return {
    nodeEnv,
    port,
    databaseUrl,
    databasePoolMax,
    sessionSecret,
    corsOrigin,
    adminEmail,
    adminPassword,
    sessionCookieName: "aidnd_session",
    ai: parseAiEnvironment(env),
    email: parseEmailEnvironment(env),
    digest: {
      schedulerEnabled: env.DIGEST_SCHEDULER_ENABLED?.trim().toLowerCase() !== "false",
      cronTriggerToken: parseCronTriggerToken(env.CRON_TRIGGER_TOKEN),
    },
    webDistDir: env.WEB_DIST_DIR?.trim() || undefined,
  };
}

export const environment = parseEnvironment(process.env);
