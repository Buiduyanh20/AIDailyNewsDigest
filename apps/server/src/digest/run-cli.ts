/**
 * Operator command: build (and optionally deliver) the Daily Digest for a JST
 * date now, using the production services. Idempotent per (user, date): a sent
 * Digest is never regenerated or resent.
 *
 *   corepack pnpm --filter @aidnd/server digest:run -- --date 2026-11-12            # finalize only
 *   corepack pnpm --filter @aidnd/server digest:run -- --date 2026-11-12 --deliver  # finalize + send now
 */
import { digestDateFor } from "@aidnd/domain";

import { environment } from "../config/env.js";
import { createDatabasePool } from "../db/pool.js";
import { ResendEmailProvider } from "../email/resend-provider.js";
import { consoleProcessingLogger } from "../events/processor.js";
import { DigestDeliveryService, DigestGenerationService } from "./service.js";
import { PostgresDigestStore } from "./store.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const localDate = argument("--date") ?? digestDateFor(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error("--date must be YYYY-MM-DD.");
  const deliver = process.argv.includes("--deliver");

  const pool = createDatabasePool();
  try {
    const store = new PostgresDigestStore(pool);
    const generation = new DigestGenerationService(store, consoleProcessingLogger);
    const delivery = new DigestDeliveryService({
      store,
      email: new ResendEmailProvider({
        apiKey: environment.email.provider === "resend" ? environment.email.resendApiKey : undefined,
        timeoutMs: environment.email.requestTimeoutMs,
      }),
      from: environment.email.from,
      logger: consoleProcessingLogger,
    });

    for (const userId of await store.listDigestUserIds()) {
      const built = await generation.generate({ userId, localDate, mode: "finalize" });
      console.log(`digest ${built.digest.id} date=${localDate} status=${built.digest.status} events=${built.eventCount}`);
      if (deliver) {
        const outcome = await delivery.deliver(built.digest.id);
        console.log(`delivery: ${JSON.stringify(outcome)}`);
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`digest:run failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
