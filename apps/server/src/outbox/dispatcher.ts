import type { Pool, QueryResultRow } from "pg";

import type { JsonValue } from "@aidnd/domain";

import { normalizeDatabaseError } from "../errors/index.js";
import type { ProcessingLogger } from "../events/processor.js";

export const ARTICLE_CREATED_EVENT = "article.created";
export const ARTICLE_REPROCESS_EVENT = "article.reprocess";

export type OutboxHandler = (payload: JsonValue) => Promise<void>;

const MAX_DISPATCH_ATTEMPTS = 10;
const STALE_DISPATCH_MINUTES = 5;

type ClaimedRow = QueryResultRow & {
  id: string;
  eventType: string;
  payload: JsonValue;
  attemptCount: number;
};

/**
 * Relays transactional outbox rows to the job queue (at-least-once). Rows are
 * claimed with SKIP LOCKED so several dispatchers never double-claim, and a
 * crashed dispatch is reclaimed after a timeout. Duplicate jobs are harmless
 * because job handlers are idempotent.
 */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly handlers: Record<string, OutboxHandler>,
    private readonly options: { batchSize?: number; intervalMs?: number; logger?: ProcessingLogger } = {},
  ) {}

  async dispatchOnce(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.dispatchBatch().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.dispatchOnce().catch((error: unknown) => {
        this.options.logger?.error({ errorCode: (error as { code?: string }).code ?? "OUTBOX_DISPATCH_FAILED" }, "outbox dispatch failed");
      });
    }, this.options.intervalMs ?? 3_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running?.catch(() => undefined);
  }

  private async query<T extends QueryResultRow>(sql: string, values: unknown[]): Promise<T[]> {
    try {
      return (await this.pool.query<T>(sql, values)).rows;
    } catch (error) {
      throw normalizeDatabaseError(error);
    }
  }

  private async dispatchBatch(): Promise<number> {
    const handledTypes = Object.keys(this.handlers);
    const claimed = await this.query<ClaimedRow>(
      `UPDATE outbox_events
       SET status = 'dispatching', attempt_count = attempt_count + 1, updated_at = now()
       WHERE id IN (
         SELECT id FROM outbox_events
         WHERE event_type = ANY($2::text[])
           AND ((status = 'pending' AND available_at <= now())
                OR (status = 'dispatching' AND updated_at < now() - make_interval(mins => $3::int)))
         ORDER BY created_at, id
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, event_type AS "eventType", payload, attempt_count AS "attemptCount"`,
      [this.options.batchSize ?? 20, handledTypes, STALE_DISPATCH_MINUTES],
    );

    let dispatched = 0;
    for (const row of claimed) {
      try {
        await this.handlers[row.eventType]!(row.payload);
        await this.query(
          `UPDATE outbox_events SET status = 'dispatched', processed_at = now(), last_error_code = NULL, updated_at = now()
           WHERE id = $1`,
          [row.id],
        );
        dispatched += 1;
      } catch {
        const exhausted = row.attemptCount >= MAX_DISPATCH_ATTEMPTS;
        const delaySeconds = Math.min(300, 2 ** row.attemptCount);
        await this.query(
          `UPDATE outbox_events
           SET status = $2, last_error_code = 'DISPATCH_FAILED',
               available_at = now() + make_interval(secs => $3::int), updated_at = now()
           WHERE id = $1`,
          [row.id, exhausted ? "failed" : "pending", delaySeconds],
        );
        this.options.logger?.warn({ outboxEventId: row.id, eventType: row.eventType, attempt: row.attemptCount, exhausted }, "outbox dispatch attempt failed");
      }
    }
    return dispatched;
  }
}

export function articleIdFromPayload(payload: JsonValue): string {
  if (payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.articleId === "string") {
    return payload.articleId;
  }
  throw new Error("Outbox payload does not contain an articleId.");
}
