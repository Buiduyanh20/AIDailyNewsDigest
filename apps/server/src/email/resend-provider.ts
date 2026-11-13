import { createHmac, timingSafeEqual } from "node:crypto";

import {
  EmailProviderError,
  type DeliveryStatus,
  type EmailProvider,
  type SendEmailInput,
  type SendEmailResult,
} from "./provider.js";

const RESEND_BASE_URL = "https://api.resend.com";

export type ResendEmailProviderOptions = {
  apiKey: string | undefined;
  timeoutMs?: number;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

type ResendErrorBody = { name?: string; message?: string; statusCode?: number };

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 300_000) : undefined;
}

/**
 * Resend adapter (https://resend.com/docs/api-reference). The only module that
 * knows Resend's HTTP API. Uses the Idempotency-Key header so a retried send
 * with the same logical key cannot produce a second email.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ResendEmailProviderOptions) {
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.baseUrl = options.baseUrl ?? RESEND_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const response = await this.request("/emails", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    if (!response.ok) throw await this.mapHttpError(response);

    let body: { id?: unknown };
    try {
      body = (await response.json()) as { id?: unknown };
    } catch {
      throw new EmailProviderError("EMAIL_INVALID_RESPONSE", "The email provider returned an unreadable response.");
    }
    if (typeof body.id !== "string" || !body.id) {
      throw new EmailProviderError("EMAIL_INVALID_RESPONSE", "The email provider did not return a message id.");
    }
    return { status: "accepted", providerMessageId: body.id };
  }

  async getDeliveryStatus(messageId: string): Promise<DeliveryStatus> {
    const response = await this.request(`/emails/${encodeURIComponent(messageId)}`, { method: "GET" });
    if (response.status === 404) return "not_found";
    if (!response.ok) throw await this.mapHttpError(response);
    const body = (await response.json().catch(() => ({}))) as { last_event?: string };
    return mapResendEvent(body.last_event) ?? "accepted";
  }

  private async request(path: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    if (!this.apiKey) {
      throw new EmailProviderError("EMAIL_NOT_CONFIGURED", "The email provider is not configured.");
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "user-agent": "ai-daily-news-digest/1.0",
          ...init.headers,
        },
        body: init.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new EmailProviderError("EMAIL_TIMEOUT", "The email provider timed out.");
      }
      throw new EmailProviderError("EMAIL_NETWORK_ERROR", "The email provider could not be reached.");
    }
  }

  /** Maps HTTP failures to stable codes; only Resend's error *name* is inspected, never echoed. */
  private async mapHttpError(response: Response): Promise<EmailProviderError> {
    const status = response.status;
    const body = (await response.json().catch(() => ({}))) as ResendErrorBody;
    const name = body.name ?? "";

    if (status === 401 || status === 403 || name === "missing_api_key" || name === "invalid_api_key" || name === "restricted_api_key") {
      return new EmailProviderError("EMAIL_AUTH_ERROR", "The email provider rejected the credentials or sender.");
    }
    if (status === 429) {
      return new EmailProviderError("EMAIL_RATE_LIMITED", "The email provider rate limit was reached.", {
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      });
    }
    if (status === 409) {
      // "concurrent_idempotent_requests" resolves on retry; a payload mismatch for the same key does not.
      return name === "invalid_idempotent_request"
        ? new EmailProviderError("EMAIL_INVALID_REQUEST", "The email provider rejected the idempotent request.")
        : new EmailProviderError("EMAIL_IDEMPOTENCY_CONFLICT", "The email provider is still processing this request.");
    }
    if (status >= 500) {
      return new EmailProviderError("EMAIL_PROVIDER_UNAVAILABLE", "The email provider is temporarily unavailable.");
    }
    return new EmailProviderError("EMAIL_INVALID_REQUEST", "The email provider rejected the request.");
  }
}

/** Resend event/`last_event` names → internal delivery status. */
export function mapResendEvent(event: string | undefined): DeliveryStatus | null {
  switch ((event ?? "").replace(/^email\./, "")) {
    case "delivered":
    case "complained":
    case "opened":
    case "clicked":
      return "delivered";
    case "bounced":
    case "failed":
      return "failed";
    case "sent":
    case "queued":
    case "scheduled":
    case "delivery_delayed":
      return "accepted";
    default:
      return null;
  }
}

/**
 * Verifies a Resend webhook (Svix scheme): HMAC-SHA256 over
 * "{svix-id}.{svix-timestamp}.{raw body}" with the base64 secret after "whsec_".
 */
export function verifyResendWebhook(
  secret: string,
  headers: { id: string | undefined; timestamp: string | undefined; signature: string | undefined },
  rawBody: string,
  now: Date = new Date(),
  toleranceSeconds = 300,
): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(now.getTime() / 1000 - timestamp) > toleranceSeconds) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  return headers.signature.split(" ").some((entry) => {
    const [version, value] = entry.split(",");
    if (version !== "v1" || !value) return false;
    const candidate = Buffer.from(value, "base64");
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  });
}
