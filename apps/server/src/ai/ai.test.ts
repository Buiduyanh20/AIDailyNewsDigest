import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countSentences,
  rankCandidateEvents,
  tokenizeForMatching,
  validateVietnameseEventContent,
} from "@aidnd/domain";

import { GeminiProvider, parseRetryDelay, toGeminiSchema } from "./gemini-provider.js";
import { buildClusteringRequest, buildSummaryRequest, clusteringResponseSchema, type PromptArticle } from "./prompts.js";
import { AIProviderError } from "./provider.js";
import { backoffDelay, DEFAULT_AI_RETRY_POLICY, runWithAiRetry } from "./retry.js";
import { validateClusteringOutput, validateSummaryOutput } from "./schemas.js";

const FAKE_KEY = "unit-test-key-should-never-leak-7f3a";

const VI_SUMMARY =
  "Bão X đã đổ bộ vào các tỉnh miền Trung Việt Nam chiều 11/11. Mưa lớn gây ngập úng tại nhiều khu vực. Chính quyền địa phương đã sơ tán hàng nghìn hộ dân.";

const article: PromptArticle = {
  id: "00000000-0000-4000-8000-000000000001",
  sourceName: "VnExpress",
  title: "Bão X đổ bộ miền Trung",
  language: "vi",
  publishedAt: "2026-11-11T09:00:00.000Z",
  url: "https://example.com/a",
  excerpt: "Bão X đổ bộ.",
};

// ---------------------------------------------------------------------------
// Domain rules
// ---------------------------------------------------------------------------

test("tokenizer handles Vietnamese diacritics, numbers, and Japanese bigrams", () => {
  const vi = tokenizeForMatching("Bão số 3 đổ bộ Đà Nẵng");
  assert.ok(vi.has("bao") && vi.has("3") && vi.has("nang"));
  const ja = tokenizeForMatching("台風10号が上陸");
  assert.ok(ja.has("台風") && ja.has("上陸"));
});

test("candidate ranking prefers overlap, keeps zero-overlap events for cross-language, and is bounded", () => {
  const ranked = rankCandidateEvents(
    "Typhoon Yagi hits central Vietnam",
    [
      { eventId: "e-economy", lastSeenAt: "2026-11-11T12:00:00.000Z", texts: ["Nhật Bản công bố chính sách kinh tế"] },
      { eventId: "e-yagi", lastSeenAt: "2026-11-11T08:00:00.000Z", texts: ["Bão Yagi đổ bộ miền Trung"] },
      { eventId: "e-old", lastSeenAt: "2026-11-10T08:00:00.000Z", texts: ["台風が上陸"] },
    ],
    2,
  );
  assert.deepEqual(
    ranked.map((entry) => entry.eventId),
    ["e-yagi", "e-economy"],
  );
  assert.ok(ranked[0]!.score > 0);
  assert.equal(ranked[1]!.score, 0);
});

test("Vietnamese content rules accept 2–4 sentence Vietnamese and reject English or rewrites", () => {
  assert.deepEqual(validateVietnameseEventContent({ titleVi: "Bão X đổ bộ miền Trung", summaryVi: VI_SUMMARY }), []);
  assert.equal(countSentences(VI_SUMMARY), 3);
  assert.ok(
    validateVietnameseEventContent({
      titleVi: "Typhoon X hits Vietnam",
      summaryVi: "Typhoon X made landfall. Heavy rain followed. Thousands were evacuated.",
    }).includes("title_not_vietnamese"),
  );
  const rewrite = Array.from({ length: 7 }, () => "Bão X gây mưa lớn ở miền Trung.").join(" ");
  assert.ok(validateVietnameseEventContent({ titleVi: "Bão X", summaryVi: rewrite }).includes("summary_sentence_count"));
});

// ---------------------------------------------------------------------------
// Structured output validation
// ---------------------------------------------------------------------------

const candidateArticleIds = new Map([["event-1", new Set(["member-1", "member-2"])]]);
const SAME_IDENTITY = { sameActors: true, sameAction: true, compatibleLocation: true, compatibleTime: true };

test("clustering validation accepts a grounded merge and normalises new_event/uncertain", () => {
  const merge = validateClusteringOutput(
    { decision: "merge", eventId: "event-1", articleIds: [article.id, "member-1"], reason: "Same storm landfall.", eventIdentity: SAME_IDENTITY },
    { articleId: article.id, candidateArticleIds },
  );
  assert.equal(merge.eventId, "event-1");
  assert.equal(merge.decision, "merge");
  assert.equal(merge.downgradedFrom, null);

  const fresh = validateClusteringOutput(
    { decision: "new_event", eventId: "event-1", articleIds: [article.id], reason: "Different event." },
    { articleId: article.id, candidateArticleIds },
  );
  assert.equal(fresh.eventId, null);

  const unsure = validateClusteringOutput(
    { decision: "uncertain", eventId: null, articleIds: [], reason: "Not enough evidence." },
    { articleId: article.id, candidateArticleIds },
  );
  assert.equal(unsure.decision, "uncertain");
});

test("clustering validation rejects invented events, invented articles, and malformed output", () => {
  const context = { articleId: article.id, candidateArticleIds };
  const isInvalid = (error: unknown) => error instanceof AIProviderError && error.code === "AI_INVALID_OUTPUT";
  assert.throws(() => validateClusteringOutput({ decision: "merge", eventId: "event-999", articleIds: [article.id], reason: "x" }, context), isInvalid);
  assert.throws(() => validateClusteringOutput({ decision: "merge", eventId: "event-1", articleIds: ["made-up"], reason: "x" }, context), isInvalid);
  assert.throws(() => validateClusteringOutput({ decision: "maybe", eventId: null, articleIds: [], reason: "x" }, context), isInvalid);
  assert.throws(() => validateClusteringOutput("not json object", context), isInvalid);
});

test("summary validation enforces evidence grounding and Vietnamese output", () => {
  const allowed = new Set([article.id]);
  const valid = validateSummaryOutput({ titleVi: " Bão X đổ bộ miền Trung ", summaryVi: VI_SUMMARY, evidenceArticleIds: [article.id] }, allowed);
  assert.equal(valid.titleVi, "Bão X đổ bộ miền Trung");
  const isInvalid = (error: unknown) => error instanceof AIProviderError && error.code === "AI_INVALID_OUTPUT";
  assert.throws(() => validateSummaryOutput({ titleVi: "Bão X", summaryVi: VI_SUMMARY, evidenceArticleIds: ["other"] }, allowed), isInvalid);
  assert.throws(() => validateSummaryOutput({ titleVi: "Bão X", summaryVi: VI_SUMMARY, evidenceArticleIds: [] }, allowed), isInvalid);
  assert.throws(
    () => validateSummaryOutput({ titleVi: "Bão X đổ bộ", summaryVi: "Typhoon X hit the coast today. Many were evacuated.", evidenceArticleIds: [article.id] }, allowed),
    isInvalid,
  );
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test("prompts are versioned and send only the fields the model needs", () => {
  const clustering = buildClusteringRequest(article, [
    { eventId: "event-1", titleVi: "Bão X", summaryVi: "Tóm tắt.", articles: [{ id: "member-1", sourceName: "VTV", title: "Bão X", language: "vi", publishedAt: null }] },
  ]);
  assert.equal(clustering.promptVersion, "event-clustering-v2");
  assert.match(clustering.systemInstruction, /untrusted news data/);
  assert.doesNotMatch(clustering.prompt, /userId|passwordHash|session|api[_-]?key/i);

  const summary = buildSummaryRequest([article]);
  assert.equal(summary.promptVersion, "event-summary-v2");
  assert.match(summary.systemInstruction, /Vietnamese/);
  assert.match(summary.systemInstruction, /ONLY facts/);
});

// ---------------------------------------------------------------------------
// Gemini adapter
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(respond: () => Response | Promise<Response>, calls: FetchCall[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
}

function geminiOk(text: string, finishReason = "STOP"): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, thoughtsTokenCount: 10, totalTokenCount: 170 },
      modelVersion: "gemini-test-001",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function assertNoKeyLeak(error: unknown): void {
  const serialized = `${String(error)} ${JSON.stringify(error)} ${(error as Error).message}`;
  assert.ok(!serialized.includes(FAKE_KEY), "error must not contain the API key");
}

test("Gemini adapter sends the key only in a header and returns parsed JSON with usage", async () => {
  const calls: FetchCall[] = [];
  const provider = new GeminiProvider({
    apiKey: FAKE_KEY,
    model: "gemini-test",
    fetchImpl: fakeFetch(() => geminiOk(JSON.stringify({ decision: "new_event", eventId: null, articleIds: [], reason: "r" })), calls),
  });
  const result = await provider.generateStructured(buildClusteringRequest(article, []));

  assert.deepEqual(result.output, { decision: "new_event", eventId: null, articleIds: [], reason: "r" });
  assert.equal(result.model, "gemini-test-001");
  assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 50, totalTokens: 170, estimatedCost: null });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0]!.url.includes(FAKE_KEY), "key must not be in the URL");
  assert.match(calls[0]!.url, /models\/gemini-test:generateContent$/);
  assert.equal((calls[0]!.init.headers as Record<string, string>)["x-goog-api-key"], FAKE_KEY);
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseSchema.type, "OBJECT");
});

test("Gemini adapter maps provider failures to stable, secret-free errors", async () => {
  const cases: Array<{ response: () => Response; code: string; transient: boolean }> = [
    { response: () => new Response(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }), { status: 401 }), code: "AI_AUTH_ERROR", transient: false },
    {
      response: () => new Response(JSON.stringify({ error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }), { status: 400 }),
      code: "AI_AUTH_ERROR",
      transient: false,
    },
    { response: () => new Response("{}", { status: 400 }), code: "AI_BAD_REQUEST", transient: false },
    { response: () => new Response("{}", { status: 404 }), code: "AI_MODEL_NOT_FOUND", transient: false },
    { response: () => new Response("{}", { status: 429, headers: { "retry-after": "2" } }), code: "AI_RATE_LIMITED", transient: true },
    { response: () => new Response("upstream down", { status: 503 }), code: "AI_PROVIDER_UNAVAILABLE", transient: true },
    { response: () => geminiOk("not json at all"), code: "AI_INVALID_RESPONSE", transient: false },
    { response: () => geminiOk('{"partial":', "MAX_TOKENS"), code: "AI_INVALID_RESPONSE", transient: false },
    {
      response: () => new Response(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }), { status: 200 }),
      code: "AI_INVALID_RESPONSE",
      transient: false,
    },
  ];

  for (const entry of cases) {
    const provider = new GeminiProvider({ apiKey: FAKE_KEY, model: "gemini-test", fetchImpl: fakeFetch(entry.response) });
    await assert.rejects(provider.generateSummary(buildSummaryRequest([article])), (error: unknown) => {
      assert.ok(error instanceof AIProviderError);
      assert.equal(error.code, entry.code);
      assert.equal(error.transient, entry.transient);
      assertNoKeyLeak(error);
      return true;
    });
  }

  const rateLimited = new GeminiProvider({
    apiKey: FAKE_KEY,
    model: "gemini-test",
    fetchImpl: fakeFetch(() => new Response("{}", { status: 429, headers: { "retry-after": "2" } })),
  });
  await assert.rejects(rateLimited.generateSummary(buildSummaryRequest([article])), (error: unknown) => {
    return error instanceof AIProviderError && error.options.retryAfterMs === 2000;
  });
});

test("Gemini 429 RetryInfo (per-minute free-tier quota) is honoured by the retry backoff", async () => {
  // Shape observed from the live API in Phase 7: no Retry-After header, RetryInfo in the body.
  const quota429 = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          details: [
            { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier" }] },
            { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "26s" },
          ],
        },
      }),
      { status: 429 },
    );
  const provider = new GeminiProvider({ apiKey: FAKE_KEY, model: "gemini-test", fetchImpl: fakeFetch(quota429) });
  await assert.rejects(provider.generateSummary(buildSummaryRequest([article])), (error: unknown) => {
    return error instanceof AIProviderError && error.code === "AI_RATE_LIMITED" && error.options.retryAfterMs === 26_000;
  });

  assert.equal(parseRetryDelay("26s"), 26_000);
  assert.equal(parseRetryDelay("1.5s"), 1_500);
  assert.equal(parseRetryDelay("600s"), 60_000, "bounded");
  assert.equal(parseRetryDelay("soon"), undefined);
  // The provider wait wins over the 15s policy cap (retrying earlier would hit the same quota)...
  assert.equal(backoffDelay(DEFAULT_AI_RETRY_POLICY, 0, () => 0.5, 26_000), 26_000);
  // ...but is itself bounded.
  assert.equal(backoffDelay(DEFAULT_AI_RETRY_POLICY, 0, () => 0.5, 300_000), 60_000);

  // End to end: a 429 then success waits the requested time once, then succeeds.
  const sleeps: number[] = [];
  let calls = 0;
  const flaky = new GeminiProvider({
    apiKey: FAKE_KEY,
    model: "gemini-test",
    fetchImpl: (async () => (++calls === 1 ? quota429() : geminiOk(JSON.stringify({ ok: true })))) as typeof fetch,
  });
  const result = await runWithAiRetry(() => flaky.generateStructured(buildClusteringRequest(article, [])), DEFAULT_AI_RETRY_POLICY, {
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
  });
  assert.deepEqual(result.output, { ok: true });
  assert.deepEqual(sleeps, [26_000]);
});

test("Gemini adapter maps timeouts and network errors, and refuses to run without a key", async () => {
  const timeout = new GeminiProvider({
    apiKey: FAKE_KEY,
    model: "gemini-test",
    fetchImpl: (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch,
  });
  await assert.rejects(timeout.generateStructured(buildClusteringRequest(article, [])), (error: unknown) => {
    return error instanceof AIProviderError && error.code === "AI_TIMEOUT" && error.transient;
  });

  const network = new GeminiProvider({
    apiKey: FAKE_KEY,
    model: "gemini-test",
    fetchImpl: (async () => {
      throw new TypeError(`fetch failed for key ${FAKE_KEY}`);
    }) as typeof fetch,
  });
  await assert.rejects(network.generateStructured(buildClusteringRequest(article, [])), (error: unknown) => {
    assert.ok(error instanceof AIProviderError && error.code === "AI_NETWORK_ERROR");
    assertNoKeyLeak(error);
    return true;
  });

  let called = false;
  const missingKey = new GeminiProvider({
    apiKey: undefined,
    model: "gemini-test",
    fetchImpl: (async () => {
      called = true;
      return geminiOk("{}");
    }) as typeof fetch,
  });
  await assert.rejects(missingKey.generateSummary(buildSummaryRequest([article])), (error: unknown) => {
    return error instanceof AIProviderError && error.code === "AI_NOT_CONFIGURED";
  });
  assert.equal(called, false);
});

test("response schema converts to Gemini's OpenAPI-style format", () => {
  const schema = toGeminiSchema(clusteringResponseSchema);
  assert.equal(schema.type, "OBJECT");
  assert.deepEqual(schema.properties?.decision, { type: "STRING", enum: ["merge", "new_event", "uncertain"] });
  assert.equal(schema.properties?.eventId?.nullable, true);
  assert.equal(schema.properties?.articleIds?.items?.type, "STRING");
  assert.deepEqual(schema.required, ["decision", "eventId", "articleIds", "reason", "eventIdentity"]);
  // Nested object (v2 event identity) converts recursively.
  assert.equal(schema.properties?.eventIdentity?.type, "OBJECT");
  assert.equal(schema.properties?.eventIdentity?.properties?.sameAction?.type, "BOOLEAN");
  assert.deepEqual(schema.properties?.eventIdentity?.required, ["sameActors", "sameAction", "compatibleLocation", "compatibleTime"]);
});

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

test("AI retry is bounded with backoff for transient errors and limited for invalid output", async () => {
  const sleeps: number[] = [];
  const hooks = { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0.5 };

  let transientCalls = 0;
  await assert.rejects(
    runWithAiRetry(async () => {
      transientCalls += 1;
      throw new AIProviderError("AI_PROVIDER_UNAVAILABLE", "down");
    }, DEFAULT_AI_RETRY_POLICY, hooks),
    (error: unknown) => error instanceof AIProviderError && error.code === "AI_PROVIDER_UNAVAILABLE",
  );
  assert.equal(transientCalls, 3);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps[1]! > sleeps[0]!, "backoff grows");

  let invalidCalls = 0;
  await assert.rejects(
    runWithAiRetry(async () => {
      invalidCalls += 1;
      throw new AIProviderError("AI_INVALID_OUTPUT", "bad");
    }, DEFAULT_AI_RETRY_POLICY, hooks),
  );
  assert.equal(invalidCalls, 2);

  let authCalls = 0;
  await assert.rejects(
    runWithAiRetry(async () => {
      authCalls += 1;
      throw new AIProviderError("AI_AUTH_ERROR", "denied");
    }, DEFAULT_AI_RETRY_POLICY, hooks),
  );
  assert.equal(authCalls, 1);

  let flaky = 0;
  const value = await runWithAiRetry(async () => {
    flaky += 1;
    if (flaky === 1) throw new AIProviderError("AI_TIMEOUT", "slow");
    return "ok";
  }, DEFAULT_AI_RETRY_POLICY, hooks);
  assert.equal(value, "ok");

  for (let index = 0; index < 6; index += 1) {
    const delay = backoffDelay(DEFAULT_AI_RETRY_POLICY, index, Math.random);
    assert.ok(delay >= 0 && delay <= DEFAULT_AI_RETRY_POLICY.maxDelayMs);
  }
  assert.equal(backoffDelay(DEFAULT_AI_RETRY_POLICY, 0, () => 0, 5000), 5000, "Retry-After is honoured");
});
