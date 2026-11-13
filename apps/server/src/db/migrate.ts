import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { environment } from "../config/env.js";

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../../migrations/", import.meta.url));

export async function runMigrations(pool: Pool, migrationsDirectory = MIGRATIONS_DIRECTORY): Promise<void> {
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();

  if (migrationFiles.length === 0) {
    throw new Error("No database migration files were found.");
  }

  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("SELECT pg_advisory_xact_lock(374824916)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const appliedResult = await client.query<{ version: string }>("SELECT version FROM schema_migrations");
    const appliedVersions = new Set(appliedResult.rows.map((row) => row.version));

    for (const file of migrationFiles) {
      const version = file.slice(0, -".sql".length);
      if (appliedVersions.has(version)) {
        continue;
      }

      const sql = await readFile(join(migrationsDirectory, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
    }

    await client.query("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Database migration failed and rollback did not complete.");
      }
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function migrateDatabase(databaseUrl = environment.databaseUrl): Promise<void> {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run database migrations.");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
}
