import { settingsUpdateSchema, type SettingsResponse } from "@aidnd/contracts";
import { BUSINESS_TIMEZONE, DIGEST_SCHEDULE } from "@aidnd/domain";

import { normalizeEmail } from "../db/auth-helpers.js";
import type { AuthStore } from "../db/auth-store.js";
import { ValidationError } from "../errors/index.js";

/**
 * Digest settings. Only the recipient is editable; timezone and send time are
 * product constants. A changed recipient applies to future Digests only.
 */
export class SettingsService {
  constructor(private readonly store: AuthStore) {}

  async get(user: { id: string; email: string }): Promise<SettingsResponse> {
    const settings = await this.store.getUserSettings(user.id);
    return {
      recipientEmail: settings?.recipientEmail ?? user.email,
      timezone: BUSINESS_TIMEZONE,
      sendLocalTime: DIGEST_SCHEDULE.send,
    };
  }

  async updateRecipient(userId: string, body: unknown): Promise<SettingsResponse> {
    const parsed = settingsUpdateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "The settings are invalid.");
    }
    const saved = await this.store.createUserSettings({
      userId,
      recipientEmail: normalizeEmail(parsed.data.recipientEmail),
      timezone: BUSINESS_TIMEZONE,
      sendLocalTime: DIGEST_SCHEDULE.send,
    });
    return { recipientEmail: saved.recipientEmail, timezone: BUSINESS_TIMEZONE, sendLocalTime: DIGEST_SCHEDULE.send };
  }
}
