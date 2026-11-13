/**
 * Phase 5 domain rules for Article → Event processing.
 *
 * Everything here is deterministic and framework-independent: no AI SDK,
 * database, or HTTP concerns. The AI judge makes the semantic decision; these
 * helpers only pre-select candidates and validate AI output shape/quality.
 */

export type ArticleProcessingStatus = "pending" | "processing" | "processed" | "failed";

export const ARTICLE_PROCESSING_STATUSES: readonly ArticleProcessingStatus[] = [
  "pending",
  "processing",
  "processed",
  "failed",
];

export type ClusteringDecision = "merge" | "new_event" | "uncertain";

export const CLUSTERING_DECISIONS: readonly ClusteringDecision[] = ["merge", "new_event", "uncertain"];

/** How an Article became associated with its Event (stored in event_articles.association_method). */
export type EventAssociationMethod =
  | "ai_merge"
  | "ai_new_event"
  | "ai_uncertain"
  | "no_candidates"
  | "exact_duplicate";

/**
 * Phase 8: the core identity of the real-world event, as judged by the AI for a
 * proposed merge. Each flag is true only when the articles agree on it (or, for
 * location, when location is irrelevant/unstated in both).
 */
export type EventIdentityCheck = {
  sameActors: boolean;
  sameAction: boolean;
  compatibleLocation: boolean;
  compatibleTime: boolean;
};

/**
 * A merge is allowed only when every identity dimension is established; a
 * shared topic, country, or person alone is never enough. Missing identity
 * counts as not established (conservative).
 */
export function isEventIdentityEstablished(identity: EventIdentityCheck | null | undefined): boolean {
  return Boolean(
    identity && identity.sameActors && identity.sameAction && identity.compatibleLocation && identity.compatibleTime,
  );
}

export function associationMethodForDecision(decision: ClusteringDecision): EventAssociationMethod {
  if (decision === "merge") return "ai_merge";
  if (decision === "new_event") return "ai_new_event";
  return "ai_uncertain";
}

/** An Article may be (re)claimed for AI processing only from these states. */
export function isClaimableProcessingStatus(status: string): boolean {
  return status === "pending" || status === "failed";
}

// ---------------------------------------------------------------------------
// Deterministic candidate pre-selection
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  // English
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "at", "by", "from", "as",
  "is", "are", "was", "were", "be", "has", "have", "had", "after", "over", "into", "its", "it",
  "new", "says", "said",
  // Vietnamese (diacritics already stripped)
  "va", "cua", "cac", "nhung", "mot", "cho", "voi", "tai", "trong", "tren", "duoc", "la", "co",
  "khong", "nay", "da", "se", "dang", "ve", "theo", "sau", "khi", "tu", "den", "nguoi", "ngay",
]);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;

function stripDiacritics(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/**
 * Turns free text into comparable tokens: lower-cased Latin/Vietnamese words
 * without diacritics, numbers, and character bigrams for CJK runs (Japanese
 * has no spaces). Used only for ranking candidates, never for merge decisions.
 */
export function tokenizeForMatching(text: string): Set<string> {
  const tokens = new Set<string>();
  const normalized = text.normalize("NFKC");

  for (const run of normalized.match(CJK_RUN) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) {
      tokens.add(chars[0]!);
    }
    for (let index = 0; index < chars.length - 1; index += 1) {
      tokens.add(`${chars[index]}${chars[index + 1]}`);
    }
  }

  const latin = stripDiacritics(normalized.replace(CJK_RUN, " ")).toLowerCase();
  for (const word of latin.split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    // Keep numbers of any length ("Bão số 3"), drop one-letter words.
    if (!/^\d+$/.test(word) && word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    tokens.add(word);
  }

  return tokens;
}

export type CandidateEventForRanking = {
  eventId: string;
  lastSeenAt: string;
  /** Title, summary, and member article titles of the Event. */
  texts: string[];
};

export type RankedCandidate = {
  eventId: string;
  score: number;
};

export function overlapScore(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  return shared / Math.min(left.size, right.size);
}

/**
 * Ranks recent Events for an Article by token overlap, then recency, then id
 * (stable). Zero-overlap Events are still eligible so that cross-language
 * stories (e.g. "Bão X" vs "台風X") reach the AI judge; the limit bounds cost.
 */
export function rankCandidateEvents(
  articleText: string,
  candidates: CandidateEventForRanking[],
  limit: number,
): RankedCandidate[] {
  const articleTokens = tokenizeForMatching(articleText);
  return candidates
    .map((candidate) => ({
      eventId: candidate.eventId,
      lastSeenAt: candidate.lastSeenAt,
      score: overlapScore(articleTokens, tokenizeForMatching(candidate.texts.join(" "))),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.lastSeenAt !== right.lastSeenAt) return left.lastSeenAt < right.lastSeenAt ? 1 : -1;
      return left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0;
    })
    .slice(0, Math.max(0, limit))
    .map(({ eventId, score }) => ({ eventId, score }));
}

// ---------------------------------------------------------------------------
// Vietnamese summary quality rules
// ---------------------------------------------------------------------------

const VIETNAMESE_SPECIFIC =
  /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/iu;

/** Heuristic: share of words that carry Vietnamese-specific letters. */
export function vietnameseWordRatio(text: string): number {
  const words = text.split(/[\s,.;:!?()"“”'‘’\-–—/]+/u).filter((word) => /\p{L}/u.test(word));
  if (words.length === 0) return 0;
  const vietnamese = words.filter((word) => VIETNAMESE_SPECIFIC.test(word)).length;
  return vietnamese / words.length;
}

export function countSentences(text: string): number {
  return text
    .trim()
    .split(/(?<=[.!?…])\s+/u)
    .map((part) => part.trim())
    .filter((part) => /\p{L}/u.test(part)).length;
}

export const EVENT_TITLE_MAX_LENGTH = 200;
export const EVENT_SUMMARY_MAX_LENGTH = 1200;
export const EVENT_SUMMARY_MAX_SENTENCES = 5;

/**
 * Phase 8: generic commentary that carries no source-grounded fact (found in
 * 7 of 122 real Phase 7 summaries). Matched case-insensitively.
 */
export const SUMMARY_FILLER_PHRASES: readonly string[] = [
  "thu hút sự quan tâm",
  "đáng chú ý",
  "gây chú ý",
  "gây nhiều chú ý",
  "đáng quan tâm",
  "dư luận quan tâm",
  "quan tâm của dư luận",
  "sự chú ý của dư luận",
];

/** Filler phrases present in the text (empty when clean). */
export function findFillerPhrases(text: string): string[] {
  const normalized = text.normalize("NFC").toLowerCase();
  return SUMMARY_FILLER_PHRASES.filter((phrase) => normalized.includes(phrase));
}

/**
 * Returns rule violations for a generated Vietnamese title/summary. An empty
 * array means the content may be persisted. Target is 2–4 sentences; up to 5
 * is tolerated, more is rejected as an article rewrite rather than a summary.
 */
export function validateVietnameseEventContent(content: { titleVi: string; summaryVi: string }): string[] {
  const issues: string[] = [];
  const title = content.titleVi.trim();
  const summary = content.summaryVi.trim();

  if (title.length < 5) issues.push("title_too_short");
  if (title.length > EVENT_TITLE_MAX_LENGTH) issues.push("title_too_long");
  if (!VIETNAMESE_SPECIFIC.test(title)) issues.push("title_not_vietnamese");

  if (summary.length < 20) issues.push("summary_too_short");
  if (summary.length > EVENT_SUMMARY_MAX_LENGTH) issues.push("summary_too_long");
  const sentences = countSentences(summary);
  if (sentences < 1 || sentences > EVENT_SUMMARY_MAX_SENTENCES) issues.push("summary_sentence_count");
  if (vietnameseWordRatio(summary) < 0.2) issues.push("summary_not_vietnamese");
  if (findFillerPhrases(`${title} ${summary}`).length > 0) issues.push("summary_filler");

  return issues;
}
