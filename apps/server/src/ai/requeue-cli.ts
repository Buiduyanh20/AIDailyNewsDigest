/**
 * Operator command: queue AI processing for Articles that are pending or
 * failed (e.g. collected before Phase 5, or failed while GEMINI_API_KEY was
 * missing). Writes `article.reprocess` outbox rows; the running server's
 * outbox dispatcher turns them into process-article jobs.
 *
 *   corepack pnpm --filter @aidnd/server ai:requeue -- --limit 20
 */
import { environment } from "../config/env.js";
import { createDatabasePool } from "../db/pool.js";
import { ARTICLE_REPROCESS_EVENT } from "../outbox/dispatcher.js";

function parseLimit(argv: string[]): number {
  const index = argv.indexOf("--limit");
  const value = index >= 0 ? Number(argv[index + 1]) : 20;
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000.");
  }
  return value;
}

async function main(): Promise<void> {
  if (!environment.databaseUrl) throw new Error("DATABASE_URL is required.");
  const limit = parseLimit(process.argv.slice(2));
  const pool = createDatabasePool();
  try {
    const result = await pool.query<{ count: number }>(
      `WITH targets AS (
         SELECT a.id FROM articles a
         WHERE a.processing_status IN ('pending', 'failed')
           AND NOT EXISTS (SELECT 1 FROM event_articles ea WHERE ea.article_id = a.id)
         ORDER BY COALESCE(a.published_at, a.discovered_at) DESC, a.id
         LIMIT $1
       ), inserted AS (
         INSERT INTO outbox_events (event_key, event_type, aggregate_type, aggregate_id, payload)
         SELECT $2 || ':' || targets.id || ':' || floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
                $2, 'article', targets.id, jsonb_build_object('articleId', targets.id)
         FROM targets
         RETURNING 1
       )
       SELECT COUNT(*)::int AS count FROM inserted`,
      [limit, ARTICLE_REPROCESS_EVENT],
    );
    console.log(`Queued ${result.rows[0]?.count ?? 0} article(s) for AI processing.`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(`Requeue failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
