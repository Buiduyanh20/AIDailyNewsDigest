import PgBoss from "pg-boss";

import { InfrastructureError } from "../errors/index.js";

export interface JobQueue {
  readonly isReady: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  enqueue(name: string, data?: Record<string, unknown>, options?: PgBoss.SendOptions): Promise<string | null>;
  work<T>(name: string, handler: (data: T) => Promise<void>): Promise<void>;
  /** Persistent cron schedule (one per queue name; re-registering on restart upserts, never duplicates). */
  schedule(name: string, cron: string, timezone: string, data?: Record<string, unknown>): Promise<void>;
  unschedule(name: string): Promise<void>;
}

export class PostgresJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(
    connectionString: string,
    onError: (error: Error) => void = console.error,
    schema = "pgboss",
  ) {
    if (!connectionString) {
      throw new Error("DATABASE_URL is required to configure pg-boss.");
    }

    this.boss = new PgBoss({ connectionString, schema });
    this.boss.on("error", onError);
  }

  get isReady(): boolean {
    return this.started;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    try {
      await this.boss.start();
      if (!(await this.boss.isInstalled())) {
        throw new InfrastructureError("pg-boss did not finish installing its PostgreSQL schema.");
      }
      this.started = true;
    } catch (error) {
      const initializationError =
        error instanceof InfrastructureError
          ? error
          : new InfrastructureError("pg-boss could not be initialized.", { cause: error });
      try {
        await this.boss.stop({ graceful: false, close: true });
      } catch (stopError) {
        throw new InfrastructureError("pg-boss initialization and cleanup both failed.", {
          cause: new AggregateError([initializationError, stopError]),
        });
      }
      throw initializationError;
    }
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    try {
      // Lets active jobs (e.g. an in-flight Gemini/Resend call) finish; unfinished jobs stay
      // in pg-boss and are retried/expired by it, never lost. Bounded below Render's 30 s grace.
      await this.boss.stop({ graceful: true, timeout: 20_000, close: true, wait: true });
      this.started = false;
    } catch (error) {
      throw new InfrastructureError("pg-boss could not shut down cleanly.", { cause: error });
    }
  }

  async enqueue(
    name: string,
    data?: Record<string, unknown>,
    options?: PgBoss.SendOptions,
  ): Promise<string | null> {
    if (!this.started) {
      throw new InfrastructureError("The job queue is not ready.");
    }

    try {
      await this.boss.createQueue(name);
      if (options) {
        return await this.boss.send(name, data ?? {}, options);
      }
      return await this.boss.send(name, data ?? {});
    } catch (error) {
      throw new InfrastructureError("The job could not be enqueued.", { cause: error });
    }
  }

  async schedule(name: string, cron: string, timezone: string, data?: Record<string, unknown>): Promise<void> {
    if (!this.started) {
      throw new InfrastructureError("The job queue is not ready.");
    }

    try {
      await this.boss.createQueue(name);
      await this.boss.schedule(name, cron, data ?? {}, { tz: timezone });
    } catch (error) {
      throw new InfrastructureError("The job schedule could not be registered.", { cause: error });
    }
  }

  async unschedule(name: string): Promise<void> {
    if (!this.started) {
      throw new InfrastructureError("The job queue is not ready.");
    }

    try {
      await this.boss.unschedule(name);
    } catch (error) {
      throw new InfrastructureError("The job schedule could not be removed.", { cause: error });
    }
  }

  async work<T>(name: string, handler: (data: T) => Promise<void>): Promise<void> {
    if (!this.started) {
      throw new InfrastructureError("The job queue is not ready.");
    }

    try {
      await this.boss.createQueue(name);
      await this.boss.work<T>(name, { batchSize: 1 }, async (jobs) => {
        const job = jobs[0];
        if (job) {
          await handler(job.data);
        }
      });
    } catch (error) {
      throw new InfrastructureError("The job worker could not be registered.", { cause: error });
    }
  }
}
