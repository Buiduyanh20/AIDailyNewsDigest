import { associationMethodForDecision, rankCandidateEvents, type ClusteringDecision } from "@aidnd/domain";

import { buildClusteringRequest, buildSummaryRequest, type PromptArticle } from "../ai/prompts.js";
import { AIProviderError, type AIProvider, type AIRequest, type AIResult } from "../ai/provider.js";
import { DEFAULT_AI_RETRY_POLICY, runWithAiRetry, type RetryHooks, type RetryPolicy } from "../ai/retry.js";
import { validateClusteringOutput, validateSummaryOutput, type ValidatedSummary } from "../ai/schemas.js";
import { AppError, ConflictError } from "../errors/index.js";
import type { ArticleForProcessing, EventContent, EventProcessingStore } from "./store.js";

export type ProcessingLogger = {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
};

/** Structured JSON logger; callers pass only IDs/codes, never prompts, payloads, or secrets. */
export const consoleProcessingLogger: ProcessingLogger = {
  info: (fields, message) => console.log(JSON.stringify({ level: "info", msg: message, ...fields })),
  warn: (fields, message) => console.warn(JSON.stringify({ level: "warn", msg: message, ...fields })),
  error: (fields, message) => console.error(JSON.stringify({ level: "error", msg: message, ...fields })),
};

export const silentProcessingLogger: ProcessingLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Recent Events loaded (by recency) before deterministic ranking. Phase 7 real
 * data had ~120 Events inside the 72h window; with a pool of 50, all three
 * missed merges (Bessent relocation, UAE talks, Hegseth impeachment) lost the
 * matching Event at recency positions 50–78 although it ranked #1 by overlap.
 * This only widens the deterministic pre-selection: the AI still sees at most
 * `maxCandidates`, so AI cost is unchanged.
 */
export const DEFAULT_CANDIDATE_POOL_SIZE = 200;

export type ArticleProcessorConfig = {
  candidateWindowHours: number;
  maxCandidates: number;
  /** Recent Events loaded before deterministic ranking. */
  candidatePoolSize?: number;
  /** Existing member Articles sent with a merge summary request. */
  maxSummaryArticles?: number;
};

export type ProcessArticleResult =
  | { status: "skipped"; reason: "not_found" | "already_processed" | "not_claimable" }
  | {
      status: "processed";
      eventId: string;
      decision: ClusteringDecision | "exact_duplicate" | "no_candidates";
    }
  | { status: "failed"; errorCode: string };

export class ArticleProcessor {
  private readonly retryPolicy: RetryPolicy;
  private readonly retryHooks: RetryHooks;
  private readonly logger: ProcessingLogger;

  constructor(
    private readonly deps: {
      store: EventProcessingStore;
      ai: AIProvider;
      config: ArticleProcessorConfig;
      retryPolicy?: RetryPolicy;
      retryHooks?: RetryHooks;
      logger?: ProcessingLogger;
    },
  ) {
    this.retryPolicy = deps.retryPolicy ?? DEFAULT_AI_RETRY_POLICY;
    this.retryHooks = deps.retryHooks ?? {};
    this.logger = deps.logger ?? consoleProcessingLogger;
  }

  /**
   * Idempotent: an Article already associated with an Event, or currently
   * claimed by another run, is skipped. No database transaction is held while
   * waiting for the AI provider; results are persisted in one short transaction.
   */
  async process(articleId: string, context: { jobId?: string } = {}): Promise<ProcessArticleResult> {
    const log = { articleId, jobId: context.jobId, provider: this.deps.ai.name, model: this.deps.ai.model };
    const article = await this.deps.store.loadArticle(articleId);
    if (!article) {
      this.logger.warn(log, "process-article skipped: article not found");
      return { status: "skipped", reason: "not_found" };
    }
    if (article.eventId) {
      return { status: "skipped", reason: "already_processed" };
    }
    if (!(await this.deps.store.claimArticle(articleId))) {
      return { status: "skipped", reason: "not_claimable" };
    }

    const startedAt = Date.now();
    try {
      const result = await this.processClaimed(article);
      this.logger.info(
        { ...log, eventId: result.eventId, decision: result.decision, durationMs: Date.now() - startedAt, status: "processed" },
        "process-article completed",
      );
      return result;
    } catch (error) {
      const errorCode =
        error instanceof AIProviderError ? error.code : error instanceof AppError ? error.code : "PROCESSING_FAILED";

      if (error instanceof ConflictError) {
        // A concurrent run may have won the race; the DB constraint kept the data consistent.
        const current = await this.deps.store.loadArticle(articleId);
        if (current?.eventId) {
          return { status: "skipped", reason: "already_processed" };
        }
      }

      await this.deps.store.markFailed(articleId, errorCode);
      this.logger.error(
        { ...log, durationMs: Date.now() - startedAt, status: "failed", errorCode },
        "process-article failed; article preserved for retry",
      );
      return { status: "failed", errorCode };
    }
  }

  private async processClaimed(
    article: ArticleForProcessing,
  ): Promise<{ status: "processed"; eventId: string; decision: ClusteringDecision | "exact_duplicate" | "no_candidates" }> {
    // 1. Exact duplicate of an already-clustered Article: reuse its Event, no AI call.
    const duplicateEventId = await this.deps.store.findExactDuplicateEvent(article);
    if (duplicateEventId) {
      const persisted = await this.deps.store.persistOutcome({
        kind: "attach",
        article,
        eventId: duplicateEventId,
        method: "exact_duplicate",
        content: null,
      });
      return { status: "processed", eventId: persisted.eventId, decision: "exact_duplicate" };
    }

    // 2. Deterministic candidate pre-selection.
    const pool = await this.deps.store.listCandidateEvents({
      userId: article.userId,
      referenceTime: article.referenceTime,
      windowHours: this.deps.config.candidateWindowHours,
      poolSize: this.deps.config.candidatePoolSize ?? DEFAULT_CANDIDATE_POOL_SIZE,
    });
    const ranked = rankCandidateEvents(
      `${article.title} ${article.excerpt ?? ""}`,
      pool.map((candidate) => ({
        eventId: candidate.eventId,
        lastSeenAt: candidate.lastSeenAt,
        texts: [candidate.titleVi, candidate.summaryVi ?? "", ...candidate.articles.map((member) => member.title)],
      })),
      this.deps.config.maxCandidates,
    );
    const byId = new Map(pool.map((candidate) => [candidate.eventId, candidate]));
    const candidates = ranked.map((entry) => byId.get(entry.eventId)!).filter(Boolean);

    const promptArticle = toPromptArticle(article);

    // 3. No candidates → new Event without a clustering call.
    if (candidates.length === 0) {
      const summary = await this.summarize(article, [promptArticle], null);
      const persisted = await this.deps.store.persistOutcome({
        kind: "create",
        article,
        method: "no_candidates",
        content: summary.content,
      });
      return { status: "processed", eventId: persisted.eventId, decision: "no_candidates" };
    }

    // 4. AI semantic judgment.
    const candidateArticleIds = new Map(
      candidates.map((candidate) => [candidate.eventId, new Set(candidate.articles.map((member) => member.id))]),
    );
    const clustering = await this.callWithRecording(
      article.id,
      buildClusteringRequest(promptArticle, candidates),
      (request) => this.deps.ai.generateStructured(request),
      (output) => validateClusteringOutput(output, { articleId: article.id, candidateArticleIds }),
      (value) => ({ decision: value.decision, targetEventId: value.eventId }),
    );
    const decision = clustering.value;
    if (decision.downgradedFrom) {
      this.logger.warn(
        { articleId: article.id, candidateCount: candidates.length, decision: decision.decision },
        "AI merge downgraded to uncertain: event identity not established",
      );
    }

    if (decision.decision === "merge" && decision.eventId) {
      const members = await this.deps.store.listEventArticles(decision.eventId, this.deps.config.maxSummaryArticles ?? 7);
      const summary = await this.summarize(article, [promptArticle, ...members], decision.eventId);
      const persisted = await this.deps.store.persistOutcome({
        kind: "attach",
        article,
        eventId: decision.eventId,
        method: "ai_merge",
        content: summary.content,
      });
      return { status: "processed", eventId: persisted.eventId, decision: "merge" };
    }

    // new_event and uncertain both keep the Article in its own Event (never a forced merge).
    const summary = await this.summarize(article, [promptArticle], null);
    const persisted = await this.deps.store.persistOutcome({
      kind: "create",
      article,
      method: associationMethodForDecision(decision.decision),
      content: summary.content,
    });
    return { status: "processed", eventId: persisted.eventId, decision: decision.decision };
  }

  private async summarize(
    article: ArticleForProcessing,
    articles: PromptArticle[],
    targetEventId: string | null,
  ): Promise<{ value: ValidatedSummary; content: EventContent }> {
    const allowedIds = new Set(articles.map((entry) => entry.id));
    const request = buildSummaryRequest(articles);
    const { value, result } = await this.callWithRecording(
      article.id,
      request,
      (input) => this.deps.ai.generateSummary(input),
      (output) => validateSummaryOutput(output, allowedIds),
      () => ({ decision: null, targetEventId }),
    );
    return {
      value,
      content: {
        titleVi: value.titleVi,
        summaryVi: value.summaryVi,
        promptVersion: request.promptVersion,
        model: result.model,
        provider: result.provider,
      },
    };
  }

  /** Calls the provider with bounded retry and records every attempt in processing_attempts. */
  private async callWithRecording<T>(
    articleId: string,
    request: AIRequest,
    invoke: (request: AIRequest) => Promise<AIResult>,
    validate: (output: unknown) => T,
    describe: (value: T) => { decision: string | null; targetEventId: string | null },
  ): Promise<{ value: T; result: AIResult }> {
    return runWithAiRetry(
      async () => {
        const startedAt = new Date();
        let result: AIResult | undefined;
        try {
          result = await invoke(request);
          const value = validate(result.output);
          await this.record(articleId, request, startedAt, result, null, describe(value));
          return { value, result };
        } catch (error) {
          const code = error instanceof AIProviderError ? error.code : "PROCESSING_FAILED";
          await this.record(articleId, request, startedAt, result, error instanceof AIProviderError ? error : null, {
            decision: null,
            targetEventId: null,
          }, code);
          throw error;
        }
      },
      this.retryPolicy,
      this.retryHooks,
    );
  }

  private async record(
    articleId: string,
    request: AIRequest,
    startedAt: Date,
    result: AIResult | undefined,
    error: AIProviderError | null,
    meta: { decision: string | null; targetEventId: string | null },
    errorCode: string | null = null,
  ): Promise<void> {
    const finishedAt = new Date();
    try {
      await this.deps.store.recordAttempt({
        articleId,
        operation: request.operation,
        status: errorCode ? "failed" : "succeeded",
        provider: result?.provider ?? this.deps.ai.name,
        model: result?.model ?? this.deps.ai.model,
        promptVersion: request.promptVersion,
        errorCode,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        latencyMs: result?.latencyMs ?? error?.options.latencyMs ?? finishedAt.getTime() - startedAt.getTime(),
        inputTokens: result?.usage.inputTokens ?? null,
        outputTokens: result?.usage.outputTokens ?? null,
        totalTokens: result?.usage.totalTokens ?? null,
        estimatedCost: result?.usage.estimatedCost ?? null,
        decision: meta.decision,
        targetEventId: meta.targetEventId,
      });
    } catch (recordError) {
      // Attempt metadata is operational data; failing to write it must not lose the Article.
      this.logger.warn(
        { articleId, operation: request.operation, errorCode: recordError instanceof AppError ? recordError.code : "RECORD_FAILED" },
        "processing attempt could not be recorded",
      );
    }
  }
}

function toPromptArticle(article: ArticleForProcessing): PromptArticle {
  return {
    id: article.id,
    sourceName: article.sourceName,
    title: article.title,
    language: article.language,
    publishedAt: article.publishedAt,
    url: article.url,
    excerpt: article.excerpt,
  };
}
