import { randomUUID } from "node:crypto";

import type { DeliveryStatus, EmailProvider, SendEmailInput, SendEmailResult } from "./provider.js";

/**
 * In-process email provider for automated tests: records every send attempt
 * and never touches the network. A script function can simulate failures.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly name = "fake-email";
  /** Every call to send(), including failed ones. */
  readonly attempts: SendEmailInput[] = [];
  /** Emails the "provider" accepted, de-duplicated by idempotency key like Resend. */
  readonly sent: Array<SendEmailInput & { providerMessageId: string }> = [];
  readonly statusById = new Map<string, DeliveryStatus>();

  constructor(private readonly script: (input: SendEmailInput, attempt: number) => void | Promise<void> = () => undefined) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    this.attempts.push(input);
    await this.script(input, this.attempts.length);
    const existing = this.sent.find((email) => email.idempotencyKey === input.idempotencyKey);
    if (existing) return { status: "accepted", providerMessageId: existing.providerMessageId };
    const providerMessageId = `fake-${randomUUID()}`;
    this.sent.push({ ...input, providerMessageId });
    this.statusById.set(providerMessageId, "accepted");
    return { status: "accepted", providerMessageId };
  }

  async getDeliveryStatus(messageId: string): Promise<DeliveryStatus> {
    return this.statusById.get(messageId) ?? "not_found";
  }
}
