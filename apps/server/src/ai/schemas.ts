import { z } from "zod";

import {
  isEventIdentityEstablished,
  validateVietnameseEventContent,
  type ClusteringDecision,
  type EventIdentityCheck,
} from "@aidnd/domain";

import { AIProviderError } from "./provider.js";

const eventIdentitySchema = z.object({
  sameActors: z.boolean(),
  sameAction: z.boolean(),
  compatibleLocation: z.boolean(),
  compatibleTime: z.boolean(),
});

const rawClusteringSchema = z.object({
  decision: z.enum(["merge", "new_event", "uncertain"]),
  eventId: z.string().min(1).nullable().optional(),
  articleIds: z.array(z.string().min(1)).max(50),
  reason: z.string().trim().min(1).max(1000),
  // Required by the v2 prompt; absent identity can never support a merge.
  eventIdentity: eventIdentitySchema.nullable().optional(),
});

const rawSummarySchema = z.object({
  titleVi: z.string().trim().min(1),
  summaryVi: z.string().trim().min(1),
  evidenceArticleIds: z.array(z.string().min(1)).min(1).max(50),
});

export type ValidatedClustering = {
  decision: ClusteringDecision;
  eventId: string | null;
  articleIds: string[];
  reason: string;
  /** Set when the model said "merge" but did not establish the event identity. */
  downgradedFrom: "merge" | null;
};

export type ValidatedSummary = {
  titleVi: string;
  summaryVi: string;
  evidenceArticleIds: string[];
};

function invalid(detail: string): AIProviderError {
  // `detail` is a fixed internal label, never model text.
  return new AIProviderError("AI_INVALID_OUTPUT", `The AI output failed validation (${detail}).`);
}

/**
 * Validates the clustering judgment against what was actually offered:
 * a merge must target a candidate Event and cite only known Article IDs.
 * A well-formed merge whose event identity (actors, action, location, time)
 * is not fully established is downgraded to "uncertain" — never merged.
 */
export function validateClusteringOutput(
  output: unknown,
  context: { articleId: string; candidateArticleIds: Map<string, Set<string>> },
): ValidatedClustering {
  const parsed = rawClusteringSchema.safeParse(output);
  if (!parsed.success) throw invalid("clustering_schema");

  const { decision, reason } = parsed.data;
  const articleIds = Array.from(new Set(parsed.data.articleIds));
  const knownArticleIds = new Set<string>([context.articleId]);
  for (const ids of context.candidateArticleIds.values()) {
    for (const id of ids) knownArticleIds.add(id);
  }
  if (articleIds.some((id) => !knownArticleIds.has(id))) throw invalid("clustering_unknown_article");

  if (decision === "merge") {
    const eventId = parsed.data.eventId ?? null;
    if (!eventId || !context.candidateArticleIds.has(eventId)) throw invalid("clustering_unknown_event");
    const eventArticles = context.candidateArticleIds.get(eventId)!;
    if (articleIds.length === 0 || articleIds.some((id) => id !== context.articleId && !eventArticles.has(id))) {
      throw invalid("clustering_evidence");
    }
    const identity: EventIdentityCheck | null = parsed.data.eventIdentity ?? null;
    if (!isEventIdentityEstablished(identity)) {
      return { decision: "uncertain", eventId: null, articleIds, reason, downgradedFrom: "merge" };
    }
    return { decision, eventId, articleIds, reason, downgradedFrom: null };
  }

  // new_event / uncertain never point at an existing Event.
  return { decision, eventId: null, articleIds, reason, downgradedFrom: null };
}

/** Validates title/summary shape, Vietnamese language, and evidence grounding. */
export function validateSummaryOutput(output: unknown, eventArticleIds: Set<string>): ValidatedSummary {
  const parsed = rawSummarySchema.safeParse(output);
  if (!parsed.success) throw invalid("summary_schema");

  const evidenceArticleIds = Array.from(new Set(parsed.data.evidenceArticleIds));
  if (evidenceArticleIds.some((id) => !eventArticleIds.has(id))) throw invalid("summary_evidence");

  const content = { titleVi: parsed.data.titleVi.trim(), summaryVi: parsed.data.summaryVi.trim() };
  const issues = validateVietnameseEventContent(content);
  if (issues.length > 0) throw invalid(issues[0]!);

  return { ...content, evidenceArticleIds };
}
