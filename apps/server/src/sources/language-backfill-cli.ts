/**
 * Operator command: fill `original_language` for Articles collected before
 * Phase 8. Deterministic, local, safe to rerun; never modifies Article content.
 *
 *   corepack pnpm --filter @aidnd/server articles:backfill-language -- --dry-run
 *   corepack pnpm --filter @aidnd/server articles:backfill-language
 */
import { environment } from "../config/env.js";
import { createDatabasePool } from "../db/pool.js";
import { backfillArticleLanguages } from "./language-backfill.js";

async function main(): Promise<void> {
  if (!environment.databaseUrl) throw new Error("DATABASE_URL is required.");
  const dryRun = process.argv.includes("--dry-run");
  const pool = createDatabasePool();
  try {
    const result = await backfillArticleLanguages(pool, { dryRun });
    console.log(
      `${dryRun ? "[dry-run] " : ""}Scanned ${result.scanned} article(s) without a language; ` +
        `${dryRun ? "would update" : "updated"} ${dryRun ? result.scanned - result.undetermined : result.updated}; ` +
        `left undetermined ${result.undetermined}; by language ${JSON.stringify(result.byLanguage)}.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`Language backfill failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
