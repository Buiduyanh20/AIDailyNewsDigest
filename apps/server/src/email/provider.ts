/**
 * Provider-neutral email boundary. The digest delivery service depends only on
 * these types; vendor details live in adapters such as ResendEmailProvider.
 */

export type SendEmailInput = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Stable logical identity; providers that support it de-duplicate on this key. */
  idempotencyKey: string;
};

export type SendEmailResult = {
  status: "accepted";
  providerMessageId: string;
};

export type DeliveryStatus = "accepted" | "delivered" | "failed" | "not_found";

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
  getDeliveryStatus(messageId: string): Promise<DeliveryStatus>;
}

export type EmailErrorCode =
  | "EMAIL_NOT_CONFIGURED"
  | "EMAIL_AUTH_ERROR"
  | "EMAIL_INVALID_REQUEST"
  | "EMAIL_RATE_LIMITED"
  | "EMAIL_PROVIDER_UNAVAILABLE"
  | "EMAIL_TIMEOUT"
  | "EMAIL_NETWORK_ERROR"
  | "EMAIL_IDEMPOTENCY_CONFLICT"
  | "EMAIL_INVALID_RESPONSE";

/**
 * - transient: the provider definitely did not accept; safe to retry later.
 * - ambiguous: the outcome is unknown (e.g. timeout); reconcile before resending.
 * - permanent: configuration/validation problem; do not retry automatically.
 */
export type EmailErrorKind = "transient" | "ambiguous" | "permanent";

const KIND_BY_CODE: Record<EmailErrorCode, EmailErrorKind> = {
  EMAIL_NOT_CONFIGURED: "permanent",
  EMAIL_AUTH_ERROR: "permanent",
  EMAIL_INVALID_REQUEST: "permanent",
  EMAIL_RATE_LIMITED: "transient",
  EMAIL_PROVIDER_UNAVAILABLE: "transient",
  EMAIL_IDEMPOTENCY_CONFLICT: "transient",
  EMAIL_TIMEOUT: "ambiguous",
  EMAIL_NETWORK_ERROR: "ambiguous",
  EMAIL_INVALID_RESPONSE: "ambiguous",
};

/** Stable internal error; never carries the provider's raw payload or credentials. */
export class EmailProviderError extends Error {
  readonly kind: EmailErrorKind;

  constructor(
    readonly code: EmailErrorCode,
    message: string,
    readonly options: { retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "EmailProviderError";
    this.kind = KIND_BY_CODE[code];
  }
}
