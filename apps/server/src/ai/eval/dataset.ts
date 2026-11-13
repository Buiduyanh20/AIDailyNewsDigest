import { readFileSync } from "node:fs";

import { countSentences, findFillerPhrases } from "@aidnd/domain";

/**
 * Phase 8 AI evaluation dataset: real Phase 7 articles that exposed false
 * merges, missed merges, unsupported causal wording, and filler summaries.
 * Shared by the CI regression tests (FakeAIProvider) and the manual
 * real-Gemini runner (`ai:eval`).
 */

export type EvalArticle = {
  ref: string;
  source: string;
  feedLanguage: string | null;
  /** Expected `original_language`. */
  language: string;
  url: string;
  publishedAt: string;
  title: string;
  excerpt: string | null;
  /** Expected clustering outcome for this article (absent for the first article of a case). */
  expect?: "merge" | "not_merge";
  /** For `merge`: the article whose Event this one must join. */
  sameEventAs?: string;
};

export type EvalCaseType = "false_merge" | "same_event" | "cross_language" | "different_event" | "causal_claim" | "filler_summary";

export type EvalCase = {
  id: string;
  type: EvalCaseType;
  description: string;
  articles: EvalArticle[];
  /** Terms that must not appear in the generated title/summary (not stated by the sources). */
  forbiddenTerms?: string[];
  /** What the Phase 7 pipeline actually produced (the regression being guarded against). */
  phase7Observed?: { decision?: string; titleVi?: string; summaryVi?: string };
};

export type EvalDataset = { version: string; description: string; cases: EvalCase[] };

export const EVAL_DATASET_URL = new URL("./phase7-cases.v1.json", import.meta.url);

export function loadEvalDataset(): EvalDataset {
  return JSON.parse(readFileSync(EVAL_DATASET_URL, "utf8")) as EvalDataset;
}

export const SUMMARY_MIN_SENTENCES = 2;
export const SUMMARY_MAX_SENTENCES = 4;

/** Deterministic quality checks for a generated title/summary; empty array = pass. */
export function checkSummaryQuality(
  content: { titleVi: string; summaryVi: string },
  forbiddenTerms: readonly string[] = [],
): string[] {
  const issues: string[] = [];
  for (const phrase of findFillerPhrases(`${content.titleVi} ${content.summaryVi}`)) issues.push(`filler:${phrase}`);
  const text = `${content.titleVi} ${content.summaryVi}`.toLowerCase();
  for (const term of forbiddenTerms) {
    if (text.includes(term.toLowerCase())) issues.push(`unsupported:${term}`);
  }
  const sentences = countSentences(content.summaryVi);
  if (sentences < SUMMARY_MIN_SENTENCES || sentences > SUMMARY_MAX_SENTENCES) issues.push(`sentences:${sentences}`);
  return issues;
}

/** Whether an observed clustering outcome satisfies the expectation ("uncertain" counts as not merged). */
export function decisionMatches(
  article: Pick<EvalArticle, "expect">,
  actual: { joinedExistingEvent: boolean; joinedExpectedEvent: boolean },
): boolean {
  if (!article.expect) return true;
  return article.expect === "merge" ? actual.joinedExpectedEvent : !actual.joinedExistingEvent;
}
