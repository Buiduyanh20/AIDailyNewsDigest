import {
  AIProviderError,
  emptyUsage,
  type AIProvider,
  type AIRequest,
  type AIResult,
  type AIUsage,
  type ResponseSchema,
  type StructuredInput,
  type SummaryInput,
} from "./provider.js";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

export type GeminiProviderOptions = {
  apiKey: string | undefined;
  model: string;
  timeoutMs?: number;
  baseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

type GeminiSchema = {
  type: "STRING" | "INTEGER" | "NUMBER" | "BOOLEAN" | "ARRAY" | "OBJECT";
  enum?: string[];
  nullable?: boolean;
  description?: string;
  items?: GeminiSchema;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  propertyOrdering?: string[];
};

/** Converts the provider-neutral schema into Gemini's OpenAPI-style responseSchema. */
export function toGeminiSchema(schema: ResponseSchema): GeminiSchema {
  const base = {
    ...(schema.nullable ? { nullable: true } : {}),
    ...(schema.description ? { description: schema.description } : {}),
  };
  switch (schema.type) {
    case "string":
      return { type: "STRING", ...base, ...(schema.enum ? { enum: schema.enum } : {}) };
    case "integer":
      return { type: "INTEGER", ...base };
    case "number":
      return { type: "NUMBER", ...base };
    case "boolean":
      return { type: "BOOLEAN", ...base };
    case "array":
      return { type: "ARRAY", ...base, items: toGeminiSchema(schema.items) };
    case "object": {
      const properties = Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => [key, toGeminiSchema(value)]),
      );
      return {
        type: "OBJECT",
        ...base,
        properties,
        propertyOrdering: Object.keys(schema.properties),
        ...(schema.required ? { required: schema.required } : {}),
      };
    }
  }
}

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
};

type GeminiErrorBody = {
  error?: { status?: string; details?: Array<{ reason?: string; retryDelay?: string }> };
};

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, Math.min(date - Date.now(), 60_000));
  return undefined;
}

/** Parses a protobuf Duration string such as "26s" or "1.5s" (bounded to 60s). */
export function parseRetryDelay(value: string | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value?.trim() ?? "");
  if (!match) return undefined;
  return Math.min(Math.ceil(Number(match[1]) * 1000), 60_000);
}

function countOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

export class GeminiProvider implements AIProvider {
  readonly name = "gemini";
  readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GeminiProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.baseUrl = options.baseUrl ?? GEMINI_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  generateStructured(input: StructuredInput): Promise<AIResult> {
    return this.generate(input, 0);
  }

  generateSummary(input: SummaryInput): Promise<AIResult> {
    // Slightly higher temperature for natural Vietnamese prose; still grounded by prompt + validation.
    return this.generate(input, 0.2);
  }

  private async generate(input: AIRequest, temperature: number): Promise<AIResult> {
    if (!this.apiKey) {
      throw new AIProviderError("AI_NOT_CONFIGURED", "The AI provider is not configured.");
    }

    const url = `${this.baseUrl}/models/${encodeURIComponent(this.model)}:generateContent`;
    const body = {
      systemInstruction: { parts: [{ text: input.systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: input.prompt }] }],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
        responseSchema: toGeminiSchema(input.responseSchema),
      },
    };

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header (not query string) so the key never appears in URLs or access logs.
          "x-goog-api-key": this.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      const name = (error as { name?: string } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AIProviderError("AI_TIMEOUT", "The AI provider timed out.", { latencyMs });
      }
      throw new AIProviderError("AI_NETWORK_ERROR", "The AI provider could not be reached.", { latencyMs });
    }

    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      throw await this.mapHttpError(response, latencyMs);
    }

    let payload: GeminiResponse;
    try {
      payload = (await response.json()) as GeminiResponse;
    } catch {
      throw new AIProviderError("AI_INVALID_RESPONSE", "The AI provider returned an unreadable response.", { latencyMs });
    }

    const usage = this.mapUsage(payload);
    if (payload.promptFeedback?.blockReason) {
      throw new AIProviderError("AI_INVALID_RESPONSE", "The AI provider blocked the request.", { latencyMs });
    }

    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
      .trim();
    if (!text) {
      throw new AIProviderError("AI_INVALID_RESPONSE", "The AI provider returned no content.", { latencyMs });
    }
    if (candidate?.finishReason && candidate.finishReason !== "STOP") {
      throw new AIProviderError("AI_INVALID_RESPONSE", "The AI provider did not finish the response.", { latencyMs });
    }

    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new AIProviderError("AI_INVALID_RESPONSE", "The AI provider returned invalid JSON.", { latencyMs });
    }

    return {
      output,
      provider: this.name,
      model: payload.modelVersion?.trim() || this.model,
      latencyMs,
      usage,
    };
  }

  private mapUsage(payload: GeminiResponse): AIUsage {
    const metadata = payload.usageMetadata;
    if (!metadata) return emptyUsage();
    const candidates = countOrNull(metadata.candidatesTokenCount);
    const thoughts = countOrNull(metadata.thoughtsTokenCount);
    return {
      inputTokens: countOrNull(metadata.promptTokenCount),
      outputTokens: candidates === null && thoughts === null ? null : (candidates ?? 0) + (thoughts ?? 0),
      totalTokens: countOrNull(metadata.totalTokenCount),
      estimatedCost: null,
    };
  }

  /** Maps HTTP failures to stable codes without copying the provider's payload. */
  private async mapHttpError(response: Response, latencyMs: number): Promise<AIProviderError> {
    const status = response.status;
    let reasons: string[] = [];
    let bodyRetryAfterMs: number | undefined;
    try {
      const errorBody = (await response.json()) as GeminiErrorBody;
      reasons = (errorBody.error?.details ?? []).map((detail) => detail.reason ?? "").filter(Boolean);
      // Gemini sends quota waits as google.rpc.RetryInfo { retryDelay: "26s" } in the body, not as a header.
      bodyRetryAfterMs = parseRetryDelay(errorBody.error?.details?.find((detail) => typeof detail.retryDelay === "string")?.retryDelay);
    } catch {
      // Body is optional; only structured reasons are inspected, never echoed.
    }

    if (status === 401 || status === 403 || reasons.includes("API_KEY_INVALID")) {
      return new AIProviderError("AI_AUTH_ERROR", "The AI provider rejected the credentials.", { latencyMs });
    }
    if (status === 429) {
      return new AIProviderError("AI_RATE_LIMITED", "The AI provider rate limit was reached.", {
        latencyMs,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")) ?? bodyRetryAfterMs,
      });
    }
    if (status === 404) {
      return new AIProviderError("AI_MODEL_NOT_FOUND", "The configured AI model was not found.", { latencyMs });
    }
    if (status >= 500) {
      return new AIProviderError("AI_PROVIDER_UNAVAILABLE", "The AI provider is temporarily unavailable.", {
        latencyMs,
        retryAfterMs: parseRetryAfter(response.headers.get("retry-after")),
      });
    }
    return new AIProviderError("AI_BAD_REQUEST", "The AI provider rejected the request.", { latencyMs });
  }
}
