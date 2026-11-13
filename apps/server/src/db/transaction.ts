import type { Pool, PoolClient } from "pg";

import { InfrastructureError, normalizeDatabaseError } from "../errors/index.js";

export type TransactionClient = PoolClient;

export class PostgresTransactionManager {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (transaction: TransactionClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let transactionOpen = false;

    try {
      await client.query("BEGIN");
      transactionOpen = true;
      const result = await work(client);
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      const normalizedError = normalizeDatabaseError(error);
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new InfrastructureError("The database transaction and rollback both failed.", {
            cause: new AggregateError([normalizedError, rollbackError]),
          });
        }
      }
      throw normalizedError;
    } finally {
      client.release();
    }
  }
}
