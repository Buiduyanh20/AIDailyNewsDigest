/**
 * Phase 8 AI quality regression tests (FakeAIProvider / pure; no real Gemini).
 * Every Phase 7 failure in the evaluation dataset is pinned here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  detectLanguage,
  findFillerPhrases,
  isEventIdentityEstablished,
  normalizeLanguageTag,
  resolveArticleLanguage,
  UNKNOWN_LANGUAGE,
} from "@aidnd/domain";

import { createMemorySourceService, extractFeedLanguage } from "../../sources/service.js";
import { buildClusteringRequest, buildSummaryRequest, clusteringResponseSchema, type PromptArticle } from "../prompts.js";
import { AIProviderError } from "../provider.js";
import { validateClusteringOutput, validateSummaryOutput } from "../schemas.js";
import { checkSummaryQuality, decisionMatches, EVAL_DATASET_URL, loadEvalDataset, type EvalCase } from "./dataset.js";

const dataset = loadEvalDataset();
const caseById = (id: string): EvalCase => dataset.cases.find((entry) => entry.id === id)!;
const isInvalid = (error: unknown) => error instanceof AIProviderError && error.code === "AI_INVALID_OUTPUT";

function promptArticle(evalCase: EvalCase, index: number): PromptArticle {
  const article = evalCase.articles[index]!;
  return {
    id: `${evalCase.id}-${article.ref}`,
    sourceName: article.source,
    title: article.title,
    language: article.language,
    publishedAt: article.publishedAt,
    url: article.url,
    excerpt: article.excerpt,
  };
}

// ---------------------------------------------------------------------------
// Evaluation dataset
// ---------------------------------------------------------------------------

test("evaluation dataset is versioned, covers every Phase 7 failure category, and holds no secrets", () => {
  assert.equal(dataset.version, "phase7-real-cases-v1");
  assert.ok(dataset.cases.length >= 6);
  const types = new Set(dataset.cases.map((entry) => entry.type));
  for (const type of ["false_merge", "same_event", "cross_language", "different_event", "causal_claim", "filler_summary"]) {
    assert.ok(types.has(type as EvalCase["type"]), `missing ${type}`);
  }
  assert.equal(new Set(dataset.cases.map((entry) => entry.id)).size, dataset.cases.length, "case ids are unique");
  for (const evalCase of dataset.cases) {
    for (const [index, article] of evalCase.articles.entries()) {
      assert.ok(article.title && article.url.startsWith("https://") && article.language, `${evalCase.id}/${article.ref}`);
      if (index === 0) assert.equal(article.expect, undefined, "the first article has no candidates to judge");
      if (article.expect === "merge") assert.ok(evalCase.articles.some((other) => other.ref === article.sameEventAs));
    }
  }
  const raw = readFileSync(EVAL_DATASET_URL, "utf8");
  assert.doesNotMatch(raw, /AIza|AQ\.[A-Za-z0-9_-]{10}|re_[A-Za-z0-9]{8}|whsec_|API_KEY|SESSION_SECRET|WEBHOOK_SECRET|password|postgres:\/\/|@gmail|buiduyanh/i);
  // Cross-language coverage: vi + en + ja in one expected Event.
  assert.deepEqual(new Set(caseById("case-004").articles.map((article) => article.language)), new Set(["en", "vi", "ja"]));
});

test("decision expectations: uncertain/new_event satisfy not_merge; merge must join the expected Event", () => {
  assert.equal(decisionMatches({ expect: "not_merge" }, { joinedExistingEvent: false, joinedExpectedEvent: false }), true);
  assert.equal(decisionMatches({ expect: "not_merge" }, { joinedExistingEvent: true, joinedExpectedEvent: false }), false);
  assert.equal(decisionMatches({ expect: "merge" }, { joinedExistingEvent: true, joinedExpectedEvent: true }), true);
  assert.equal(decisionMatches({ expect: "merge" }, { joinedExistingEvent: true, joinedExpectedEvent: false }), false);
});

// ---------------------------------------------------------------------------
// False merge (case-001) and event identity
// ---------------------------------------------------------------------------

test("false merge regression: a merge without established event identity is downgraded to uncertain", () => {
  const evalCase = caseById("case-001");
  const threat = promptArticle(evalCase, 0);
  const aircraft = promptArticle(evalCase, 1);
  const context = { articleId: aircraft.id, candidateArticleIds: new Map([["event-threat", new Set([threat.id])]]) };
  const phase7Like = { decision: "merge", eventId: "event-threat", articleIds: [aircraft.id, threat.id], reason: "Both involve US bases and Iran." };

  // Shared actors/topic but a different action → never merged.
  const sharedTopicOnly = validateClusteringOutput(
    { ...phase7Like, eventIdentity: { sameActors: true, sameAction: false, compatibleLocation: false, compatibleTime: true } },
    context,
  );
  assert.deepEqual([sharedTopicOnly.decision, sharedTopicOnly.eventId, sharedTopicOnly.downgradedFrom], ["uncertain", null, "merge"]);

  // v1-shaped output (no identity) can no longer produce a merge.
  const noIdentity = validateClusteringOutput(phase7Like, context);
  assert.deepEqual([noIdentity.decision, noIdentity.eventId], ["uncertain", null]);

  // A fully established identity still merges (conservative, not disabled).
  const established = validateClusteringOutput(
    { ...phase7Like, eventIdentity: { sameActors: true, sameAction: true, compatibleLocation: true, compatibleTime: true } },
    context,
  );
  assert.deepEqual([established.decision, established.eventId], ["merge", "event-threat"]);

  // Evidence validation still runs before the identity guard.
  assert.throws(() => validateClusteringOutput({ ...phase7Like, articleIds: ["invented"] }, context), isInvalid);
  assert.throws(() => validateClusteringOutput({ ...phase7Like, eventId: "event-invented" }, context), isInvalid);
});

test("event identity requires every dimension", () => {
  const all = { sameActors: true, sameAction: true, compatibleLocation: true, compatibleTime: true };
  assert.equal(isEventIdentityEstablished(all), true);
  for (const key of Object.keys(all) as Array<keyof typeof all>) {
    assert.equal(isEventIdentityEstablished({ ...all, [key]: false }), false, key);
  }
  assert.equal(isEventIdentityEstablished(null), false);
  assert.equal(isEventIdentityEstablished(undefined), false);
});

test("clustering prompt v2 asks for the identity check and forbids topic-only or inferred-cause merges", () => {
  const evalCase = caseById("case-001");
  const request = buildClusteringRequest(promptArticle(evalCase, 1), [
    { eventId: "event-threat", titleVi: "Iran dọa tấn công căn cứ Mỹ ở châu Âu", summaryVi: null, articles: [promptArticle(evalCase, 0)] },
  ]);
  assert.equal(request.promptVersion, "event-clustering-v2");
  assert.match(request.systemInstruction, /Sharing a country, person, organization, topic/);
  assert.match(request.systemInstruction, /Do not merge on a causal link you infer yourself/);
  assert.match(request.systemInstruction, /same main actors, same specific action/);
  assert.match(request.systemInstruction, /A false merge is worse than a duplicate event/);
  assert.ok(clusteringResponseSchema.type === "object" && clusteringResponseSchema.required?.includes("eventIdentity"));
});

// ---------------------------------------------------------------------------
// Summary: causal claims (case-007), filler (case-008), grounding
// ---------------------------------------------------------------------------

test("causal claim regression: Phase 7's 'after an Iranian warning' title is detected as unsupported", () => {
  const evalCase = caseById("case-007");
  const issues = checkSummaryQuality(
    { titleVi: evalCase.phase7Observed!.titleVi!, summaryVi: "Không quân Mỹ đã điều chuyển 13 máy bay khỏi một căn cứ ở miền Đông nước Anh. Việc điều chuyển diễn ra sau khi xuất hiện mối đe dọa an ninh." },
    evalCase.forbiddenTerms,
  );
  assert.deepEqual(issues, ["unsupported:Iran"]);
  const grounded = checkSummaryQuality(
    { titleVi: "Mỹ điều chuyển 13 máy bay quân sự khỏi căn cứ tại Anh", summaryVi: "Không quân Mỹ đã điều chuyển 13 máy bay khỏi một căn cứ ở miền Đông nước Anh. Việc điều chuyển diễn ra sau khi xuất hiện mối đe dọa an ninh." },
    evalCase.forbiddenTerms,
  );
  assert.deepEqual(grounded, []);

  const request = buildSummaryRequest([promptArticle(evalCase, 0)]);
  assert.equal(request.promptVersion, "event-summary-v2");
  assert.match(request.systemInstruction, /Never invent cause and effect/);
  assert.match(request.systemInstruction, /sau cảnh báo/);
});

test("filler regression: Phase 7's padded COP31 summary is rejected; a concrete summary passes", () => {
  const evalCase = caseById("case-008");
  const article = promptArticle(evalCase, 0);
  const observed = { titleVi: evalCase.phase7Observed!.titleVi!, summaryVi: evalCase.phase7Observed!.summaryVi! };
  assert.deepEqual(findFillerPhrases(observed.summaryVi), ["thu hút sự quan tâm"]);
  assert.ok(checkSummaryQuality(observed, evalCase.forbiddenTerms).includes("unsupported:kỳ vọng"));
  assert.throws(() => validateSummaryOutput({ ...observed, evidenceArticleIds: [article.id] }, new Set([article.id])), isInvalid);

  const concrete = {
    titleVi: "Lãnh đạo thế giới tới Thổ Nhĩ Kỳ dự Hội nghị COP31",
    summaryVi:
      "Ngày 11/11, nhiều nhà lãnh đạo thế giới đã tới Thổ Nhĩ Kỳ để tham dự COP31. Đây là Hội nghị lần thứ 31 các bên tham gia Công ước khung của Liên hợp quốc về biến đổi khí hậu.",
  };
  assert.deepEqual(checkSummaryQuality(concrete, evalCase.forbiddenTerms), []);
  assert.equal(validateSummaryOutput({ ...concrete, evidenceArticleIds: [article.id] }, new Set([article.id])).titleVi, concrete.titleVi);

  const prompt = buildSummaryRequest([article]).systemInstruction;
  for (const phrase of ["đang thu hút sự quan tâm của dư luận", "đáng chú ý", "gây nhiều chú ý", "đây là một diễn biến đáng quan tâm", "được dư luận quan tâm"]) {
    assert.ok(findFillerPhrases(phrase).length > 0, `filler not detected: ${phrase}`);
  }
  assert.match(prompt, /No generic commentary/);
  assert.match(prompt, /Sentence 1: what happened/);
});

test("summary grounding: evidence must reference supplied articles only", () => {
  const evalCase = caseById("case-003");
  const supplied = new Set([promptArticle(evalCase, 0).id, promptArticle(evalCase, 1).id]);
  const content = {
    titleVi: "Bộ trưởng Tài chính Mỹ Scott Bessent chuyển vào căn cứ quân sự",
    summaryVi: "Bộ trưởng Tài chính Mỹ Scott Bessent đã chuyển vào sống trong một căn cứ quân sự. Ông là một trong số quan chức chính quyền Trump sống tại căn cứ quân sự vì lo ngại an ninh.",
  };
  assert.deepEqual(validateSummaryOutput({ ...content, evidenceArticleIds: [...supplied] }, supplied).evidenceArticleIds.length, 2);
  assert.throws(() => validateSummaryOutput({ ...content, evidenceArticleIds: ["not-supplied"] }, supplied), isInvalid);
  assert.throws(() => validateSummaryOutput({ ...content, evidenceArticleIds: [] }, supplied), isInvalid);
});

// ---------------------------------------------------------------------------
// original_language
// ---------------------------------------------------------------------------

test("language detection: every real Phase 7 dataset article resolves to its expected language", () => {
  for (const evalCase of dataset.cases) {
    for (const article of evalCase.articles) {
      const withMetadata = resolveArticleLanguage({ feedLanguage: article.feedLanguage, title: article.title, excerpt: article.excerpt });
      assert.equal(withMetadata, article.language, `${evalCase.id}/${article.ref} with feed metadata`);
      // Local detection alone must agree too (feeds such as VnExpress/NHK declare nothing).
      assert.equal(detectLanguage(`${article.title} ${article.excerpt ?? ""}`), article.language, `${evalCase.id}/${article.ref} detected`);
    }
  }
});

test("language detection is conservative and metadata wins", () => {
  assert.equal(normalizeLanguageTag("vi-VN"), "vi");
  assert.equal(normalizeLanguageTag("en-gb"), "en");
  assert.equal(normalizeLanguageTag(" ja "), "ja");
  assert.equal(normalizeLanguageTag("not a tag"), null);
  assert.equal(normalizeLanguageTag(null), null);

  assert.equal(detectLanguage("台風10号が九州に上陸、各地で大雨"), "ja");
  assert.equal(detectLanguage("NHKニュース"), "ja");
  assert.equal(detectLanguage("Bão số 3 đổ bộ Quảng Ninh"), "vi");
  assert.equal(detectLanguage("Storm hits the coast of Vietnam"), "en");
  assert.equal(detectLanguage("中国经济增长放缓"), UNKNOWN_LANGUAGE, "Han-only text is not guessed");
  assert.equal(detectLanguage("Le président a annoncé une réforme"), UNKNOWN_LANGUAGE);
  // Real Phase 7 BBC items with accented names are still English.
  assert.equal(
    detectLanguage("'It can kill us': Kenyans fear impact of El Niño with floods predicted. Forecasters warn that this year's El Niño could be one of the strongest on record."),
    "en",
  );
  assert.equal(detectLanguage("COVID-19 NATO"), UNKNOWN_LANGUAGE);
  assert.equal(detectLanguage(""), UNKNOWN_LANGUAGE);
  assert.equal(resolveArticleLanguage({ feedLanguage: "ja", title: "Breaking news" }), "ja");
  assert.equal(resolveArticleLanguage({ feedLanguage: "", title: "Bão số 3 đổ bộ" }), "vi");
});

test("feed language metadata is read from the channel header, CDATA, or Atom xml:lang only", () => {
  assert.equal(extractFeedLanguage("<rss><channel><title>BBC</title><language><![CDATA[en-gb]]></language><item><title>x</title></item></channel></rss>"), "en-gb");
  assert.equal(extractFeedLanguage("<rss><channel><language>vi-vn</language><item><title>x</title></item></channel></rss>"), "vi-vn");
  assert.equal(extractFeedLanguage('<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ja"><entry><title>x</title></entry></feed>'), "ja");
  assert.equal(extractFeedLanguage("<rss><channel><title>VnExpress</title><item><language>en</language></item></channel></rss>"), null);
});

test("RSS ingestion populates original_language without changing the original content", async () => {
  const service = createMemorySourceService();
  const realFetch = globalThis.fetch;
  const feeds: Record<string, string> = {
    "https://vi.feed.invalid/rss.xml": `<?xml version="1.0"?><rss><channel><title>VN</title>
      <item><title>Bão số 3 đổ bộ Quảng Ninh</title><link>https://vi.feed.invalid/a</link><description>Bão gây mưa lớn.</description><pubDate>Wed, 11 Nov 2026 01:00:00 GMT</pubDate></item>
      </channel></rss>`,
    "https://en.feed.invalid/rss.xml": `<?xml version="1.0"?><rss><channel><title>EN</title><language><![CDATA[en-gb]]></language>
      <item><title>Talks resume</title><link>https://en.feed.invalid/a</link><description>Negotiators met.</description><pubDate>Wed, 11 Nov 2026 01:00:00 GMT</pubDate></item>
      </channel></rss>`,
    "https://ja.feed.invalid/rss.xml": `<?xml version="1.0"?><rss><channel><title>JA</title>
      <item><title>米国防長官ら 墓地で衛兵から叱責</title><link>https://ja.feed.invalid/a</link><pubDate>Wed, 11 Nov 2026 01:00:00 GMT</pubDate></item>
      </channel></rss>`,
  };
  globalThis.fetch = (async (url: string | URL | Request) =>
    new Response(feeds[String(url)] ?? "", { status: feeds[String(url)] ? 200 : 404, headers: { "content-type": "application/rss+xml" } })) as typeof fetch;
  try {
    const expected: Record<string, { language: string; title: string }> = {
      vi: { language: "vi", title: "Bão số 3 đổ bộ Quảng Ninh" },
      en: { language: "en", title: "Talks resume" },
      ja: { language: "ja", title: "米国防長官ら 墓地で衛兵から叱責" },
    };
    for (const [code, want] of Object.entries(expected)) {
      const source = await service.createSource("user-1", { name: code, websiteUrl: `https://${code}.feed.invalid`, rssUrl: `https://${code}.feed.invalid/rss.xml` });
      assert.deepEqual(await service.collectSource(source.id), { new: 1, duplicate: 0, failed: 0 });
      const [article] = (await service.getSourceForUser("user-1", source.id)).recentArticles;
      assert.equal(article!.originalLanguage, want.language, code);
      assert.equal(article!.originalTitle, want.title, "title stored as received");
      assert.equal(article!.canonicalUrl, `https://${code}.feed.invalid/a`);
      assert.equal(article!.publishedAt, "2026-11-11T01:00:00.000Z");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
});
