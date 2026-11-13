import type { Pool } from "pg";

import { detectLanguage, UNKNOWN_LANGUAGE } from "@aidnd/domain";

export type LanguageBackfillResult = {
  scanned: number;
  updated: number;
  /** Rows left NULL because the stored text was not conclusive. */
  undetermined: number;
  byLanguage: Record<string, number>;
};

/**
 * Populates `articles.original_language` where it is NULL, from the stored
 * title + excerpt only (deterministic, no network, no AI). Never touches any
 * other column; only conclusive detections are written, so a rerun is a no-op.
 */
export async function backfillArticleLanguages(pool: Pool, options: { dryRun?: boolean } = {}): Promise<LanguageBackfillResult> {
  const { rows } = await pool.query<{ id: string; title: string; excerpt: string | null }>(
    `SELECT id, original_title AS title, original_excerpt AS excerpt
     FROM articles WHERE original_language IS NULL ORDER BY id`,
  );
  const result: LanguageBackfillResult = { scanned: rows.length, updated: 0, undetermined: 0, byLanguage: {} };

  for (const row of rows) {
    const language = detectLanguage(`${row.title} ${row.excerpt ?? ""}`);
    if (language === UNKNOWN_LANGUAGE) {
      result.undetermined += 1;
      continue;
    }
    result.byLanguage[language] = (result.byLanguage[language] ?? 0) + 1;
    if (options.dryRun) continue;
    const update = await pool.query(
      // The IS NULL guard keeps concurrent collection or a second run from overwriting a value.
      `UPDATE articles SET original_language = $2 WHERE id = $1 AND original_language IS NULL`,
      [row.id, language],
    );
    result.updated += update.rowCount ?? 0;
  }
  return result;
}
