/**
 * Manual real-Gemini integration check (NOT part of the automated suite).
 *
 *   corepack pnpm --filter @aidnd/server ai:smoke
 *
 * Uses a tiny controlled dataset, calls the configured Gemini model, and runs
 * the same validators as production. Never prints the API key.
 */
import { environment } from "../config/env.js";
import { GeminiProvider } from "./gemini-provider.js";
import { buildClusteringRequest, buildSummaryRequest, type PromptArticle } from "./prompts.js";
import { AIProviderError } from "./provider.js";
import { validateClusteringOutput, validateSummaryOutput } from "./schemas.js";

const vietnameseStorm: PromptArticle = {
  id: "00000000-0000-4000-8000-000000000001",
  sourceName: "VnExpress (fixture)",
  title: "Bão Yagi đổ bộ miền Trung, gây mưa lớn diện rộng",
  language: "vi",
  publishedAt: "2026-11-11T09:00:00.000Z",
  url: "https://example.com/vi/bao-yagi",
  excerpt:
    "Chiều 11/11, bão Yagi đổ bộ vào các tỉnh miền Trung Việt Nam với sức gió mạnh cấp 12. Mưa lớn gây ngập ở nhiều khu vực, hàng nghìn hộ dân được sơ tán.",
};

const englishStorm: PromptArticle = {
  id: "00000000-0000-4000-8000-000000000002",
  sourceName: "Global News (fixture)",
  title: "Typhoon Yagi makes landfall in central Vietnam",
  language: "en",
  publishedAt: "2026-11-11T10:30:00.000Z",
  url: "https://example.com/en/typhoon-yagi",
  excerpt:
    "Typhoon Yagi made landfall in central Vietnam on Wednesday afternoon, bringing strong winds and heavy rain. Authorities evacuated thousands of households.",
};

const japanEconomy: PromptArticle = {
  id: "00000000-0000-4000-8000-000000000003",
  sourceName: "NHK (fixture)",
  title: "日本政府、新たな経済対策を閣議決定",
  language: "ja",
  publishedAt: "2026-11-11T11:00:00.000Z",
  url: "https://example.com/ja/economy",
  excerpt: "日本政府は11日、物価高への対応を柱とする新たな経済対策を閣議決定した。",
};

function line(label: string, value: unknown): void {
  console.log(`${label.padEnd(18)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

async function main(): Promise<void> {
  const provider = new GeminiProvider({
    apiKey: environment.ai.geminiApiKey,
    model: environment.ai.geminiModel,
    timeoutMs: environment.ai.requestTimeoutMs,
  });
  line("provider/model", `${provider.name} / ${provider.model}`);
  line("api key", environment.ai.geminiApiKey ? "configured (hidden)" : "NOT configured");

  // 1. Summary for a single Vietnamese article.
  const first = await provider.generateSummary(buildSummaryRequest([vietnameseStorm]));
  const firstSummary = validateSummaryOutput(first.output, new Set([vietnameseStorm.id]));
  line("summary A title", firstSummary.titleVi);
  line("summary A", firstSummary.summaryVi);
  line("tokens/latency", { ...first.usage, latencyMs: first.latencyMs });

  const candidate = {
    eventId: "00000000-0000-4000-8000-0000000000e1",
    titleVi: firstSummary.titleVi,
    summaryVi: firstSummary.summaryVi,
    articles: [vietnameseStorm],
  };
  const candidateArticleIds = new Map([[candidate.eventId, new Set([vietnameseStorm.id])]]);

  // 2. Cross-language same event → expect merge.
  const same = await provider.generateStructured(buildClusteringRequest(englishStorm, [candidate]));
  const sameDecision = validateClusteringOutput(same.output, { articleId: englishStorm.id, candidateArticleIds });
  line("EN vs VN storm", `${sameDecision.decision} (${sameDecision.reason})`);

  // 3. Unrelated event → expect new_event (or uncertain), never merge.
  const different = await provider.generateStructured(buildClusteringRequest(japanEconomy, [candidate]));
  const differentDecision = validateClusteringOutput(different.output, { articleId: japanEconomy.id, candidateArticleIds });
  line("JA economy vs VN", `${differentDecision.decision} (${differentDecision.reason})`);

  // 4. Merged multi-language summary.
  const merged = await provider.generateSummary(buildSummaryRequest([englishStorm, vietnameseStorm]));
  const mergedSummary = validateSummaryOutput(merged.output, new Set([englishStorm.id, vietnameseStorm.id]));
  line("merged title", mergedSummary.titleVi);
  line("merged summary", mergedSummary.summaryVi);
  line("evidence", mergedSummary.evidenceArticleIds);

  const passed = sameDecision.decision === "merge" && differentDecision.decision !== "merge";
  line("result", passed ? "PASS" : "UNEXPECTED DECISIONS");
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const code = error instanceof AIProviderError ? error.code : "SMOKE_FAILED";
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`AI smoke test failed: ${code} — ${message}`);
  process.exitCode = 1;
});
