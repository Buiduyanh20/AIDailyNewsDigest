import { Pool } from "pg";

import { environment } from "../config/env.js";

/**
 * One shared pool per process (never a connection per request). TLS comes from
 * the connection string (Neon: `sslmode=require`, verified against public CAs);
 * certificate verification is never disabled.
 */
export function createDatabasePool(connectionString = environment.databaseUrl, max = environment.databasePoolMax): Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required to create a PostgreSQL connection pool.");
  }

  return new Pool({ connectionString, max, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
}
