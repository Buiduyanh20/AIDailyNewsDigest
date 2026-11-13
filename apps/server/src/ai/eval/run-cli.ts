/**
 * Manual real-Gemini evaluation over the Phase 7 regression dataset (NOT part
 * of the automated suite). Runs the production ArticleProcessor + Postgres
 * store against a dedicated evaluation database, one throw-away schema per
 * case, and checks decisions and summaries deterministically.
 *
 *   EVAL_DATABASE_URL=postgres://.../aidnd_eval corepack pnpm --filter @aidnd/server ai:eval [-- --case case-001]
 *
 * Never prints the API key, prompts, or raw model output. Sends no email.
 */
import { randomBytes } from "node:crypto";

import { Pool } from "pg";

import { resolveArticleLanguage } from "@aidnd/domain";

import { environment } from "../../config/env.js";
import { runMigrations } from "../../db/migrate.js";
import { createPostgresRepositories } from "../../db/repositories.js";
import { ArticleProcessor, type ProcessingLogger } from "../../events/processor.js";
import { PostgresEventProcessingStore } from "../../events/store.js";
import { readPromptPayload } from "../fake-provider.js";
import { GeminiProvider } from "../gemini-provider.js";
import { CLUSTERING_OPERATION, CLUSTERING_PROMPT_VERSION, SUMMARY_PROMPT_VERSION } from "../prompts.js";
import type { AIProvider, AIRequest } from "../provider.js";
import { checkSummaryQuality, decisionMatches, loadEvalDataset, type EvalCase } from "./dataset.js";

/** Delegating provider that counts calls and the candidate set size of each clustering call. */
class MeteredProvider implements AIProvider {
  readonly name: string;
  readonly model: string;
  calls = 0;
  candidateCounts: number[] = [];

  constructor(private readonly inner: AIProvider) {
    this.name = inner.name;
    this.model = inner.model;
  }

  generateStructured(input: AIRequest) {
    this.calls += 1;
    if (input.operation === CLUSTERING_OPERATION) {
      this.candidateCounts.push(readPromptPayload<{ candidateEvents: unknown[] }>(input).candidateEvents.length);
    }
    return this.inner.generateStructured(input);
  }

  generateSummary(input: AIRequest) {
    this.calls += 1;
    return this.inner.generateSummary(input);
  }
}

type CaseResult = { id: string; type: string; passed: boolean; lines: string[]; latencies: number[]; retries: number; downgrades: number };

async function runCase(databaseUrl: string, ai: MeteredProvider, evalCase: EvalCase): Promise<CaseResult> {
  const schema = `phase8_eval_${randomBytes(6).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const lines: string[] = [];
  let passed = true;
  let downgrades = 0;
  const logger: ProcessingLogger = {
    info: () => undefined,
    warn: (_fields, message) => {
      if (message.startsWith("AI merge downgraded")) downgrades += 1;
    },
    error: () => undefined,
  };

  await admin.query(`CREATE SCHEMA "${schema}"`);
  try {
    await runMigrations(pool);
    const repositories = createPostgresRepositories(pool);
    const user = await repositories.users.create({ email: `eval-${randomBytes(4).toString("hex")}@eval.invalid`, passwordHash: "x" });
    const sources = new Map<string, string>();
    const processor = new ArticleProcessor({
      store: new PostgresEventProcessingStore(pool),
      ai,
      config: { candidateWindowHours: environment.ai.candidateWindowHours, maxCandidates: environment.ai.maxCandidates },
      logger,
    });

    const articleIds = new Map<string, string>();
    for (const article of evalCase.articles) {
      if (!sources.has(article.source)) {
        const origin = new URL(article.url).origin;
        const created = await repositories.sources.create({ userId: user.id, name: article.source, websiteUrl: origin, rssUrl: `${origin}/rss` });
        sources.set(article.source, created.id);
      }
      const language = resolveArticleLanguage({ feedLanguage: article.feedLanguage, title: article.title, excerpt: article.excerpt });
      if (language !== article.language) {
        passed = false;
        lines.push(`  language ${article.ref}: ${language} (expected ${article.language}) FAIL`);
      }
      const created = await repositories.articles.create({
        sourceId: sources.get(article.source)!,
        originalUrl: article.url,
        canonicalUrl: article.url,
        originalTitle: article.title,
        originalLanguage: language,
        originalExcerpt: article.excerpt,
        originalContent: article.excerpt,
        publishedAt: article.publishedAt,
        publishedDateJst: new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date(article.publishedAt)),
      });
      articleIds.set(article.ref, created.id);

      const result = await processor.process(created.id);
      if (result.status !== "processed") {
        passed = false;
        lines.push(`  ${article.ref}: ${result.status}${"errorCode" in result ? ` ${result.errorCode}` : ""} FAIL`);
        continue;
      }
      const eventOf = async (id: string) =>
        (await pool.query<{ eventId: string; method: string }>(
          `SELECT event_id AS "eventId", association_method AS method FROM event_articles WHERE article_id = $1`,
          [id],
        )).rows[0];
      const own = await eventOf(created.id);
      const expected = article.sameEventAs ? await eventOf(articleIds.get(article.sameEventAs)!) : undefined;
      const outcome = {
        joinedExistingEvent: own?.method === "ai_merge" || own?.method === "exact_duplicate",
        joinedExpectedEvent: Boolean(expected && own && expected.eventId === own.eventId),
      };
      const ok = decisionMatches(article, outcome);
      if (!ok) passed = false;
      if (article.expect) {
        lines.push(`  ${article.ref} [${article.language}] decision=${result.decision} expected=${article.expect} ${ok ? "PASS" : "FAIL"}`);
      }
    }

    const events = await pool.query<{ titleVi: string; summaryVi: string; promptVersion: string }>(
      `SELECT title_vi AS "titleVi", summary_vi AS "summaryVi", prompt_version AS "promptVersion" FROM events ORDER BY created_at`,
    );
    for (const event of events.rows) {
      const issues = checkSummaryQuality(event, evalCase.forbiddenTerms);
      if (issues.length > 0 || event.promptVersion !== SUMMARY_PROMPT_VERSION) passed = false;
      lines.push(`  title: ${event.titleVi}`);
      lines.push(`  summary: ${event.summaryVi}`);
      lines.push(`  checks: ${issues.length === 0 ? "PASS" : `FAIL ${issues.join(", ")}`} (${event.promptVersion})`);
    }

    const attempts = await pool.query<{ status: string; latencyMs: number | null; promptVersion: string | null }>(
      `SELECT status, latency_ms AS "latencyMs", prompt_version AS "promptVersion" FROM processing_attempts`,
    );
    const clusteringVersions = new Set(
      attempts.rows.map((row) => row.promptVersion ?? "").filter((version) => version.startsWith("event-clustering")),
    );
    if ([...clusteringVersions].some((version) => version !== CLUSTERING_PROMPT_VERSION)) passed = false;
    return {
      id: evalCase.id,
      type: evalCase.type,
      passed,
      lines,
      latencies: attempts.rows.filter((row) => row.status === "succeeded").map((row) => row.latencyMs ?? 0),
      retries: attempts.rows.filter((row) => row.status === "failed").length,
      downgrades,
    };
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.EVAL_DATABASE_URL;
  if (!databaseUrl) throw new Error("EVAL_DATABASE_URL (a dedicated evaluation database) is required.");
  if (environment.databaseUrl && databaseUrl === environment.databaseUrl) {
    throw new Error("EVAL_DATABASE_URL must not be the application DATABASE_URL.");
  }
  const only = process.argv.includes("--case") ? process.argv[process.argv.indexOf("--case") + 1] : undefined;
  const dataset = loadEvalDataset();
  const ai = new MeteredProvider(
    new GeminiProvider({ apiKey: environment.ai.geminiApiKey, model: environment.ai.geminiModel, timeoutMs: environment.ai.requestTimeoutMs }),
  );
  console.log(`dataset ${dataset.version} | ${ai.name} / ${ai.model} | prompts ${CLUSTERING_PROMPT_VERSION}, ${SUMMARY_PROMPT_VERSION}`);
  console.log(`api key ${environment.ai.geminiApiKey ? "configured (hidden)" : "NOT configured"}`);

  const results: CaseResult[] = [];
  for (const evalCase of dataset.cases.filter((entry) => !only || entry.id === only)) {
    const result = await runCase(databaseUrl, ai, evalCase);
    results.push(result);
    console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id} (${result.type})`);
    for (const entry of result.lines) console.log(entry);
  }

  const latencies = results.flatMap((result) => result.latencies);
  const articles = results.reduce((sum, result) => sum + (dataset.cases.find((c) => c.id === result.id)?.articles.length ?? 0), 0);
  console.log("--- metrics ---");
  console.log(`cases ${results.filter((r) => r.passed).length}/${results.length} passed`);
  console.log(`articles ${articles}`);
  console.log(`AI calls ${ai.calls} (clustering ${ai.candidateCounts.length}, candidates per clustering call ${JSON.stringify(ai.candidateCounts)})`);
  console.log(`average latency ${latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0} ms`);
  console.log(`retries (failed attempts) ${results.reduce((sum, r) => sum + r.retries, 0)}`);
  console.log(`merges downgraded by identity guard ${results.reduce((sum, r) => sum + r.downgrades, 0)}`);
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`AI evaluation failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
