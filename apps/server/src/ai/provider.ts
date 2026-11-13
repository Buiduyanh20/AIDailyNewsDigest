/**
 * Provider-neutral AI boundary. Application code (event processing) depends
 * only on these types; vendor details live in adapters such as GeminiProvider.
 */

/** Minimal JSON-schema subset understood by every adapter. */
export type ResponseSchema =
  | { type: "string"; enum?: string[]; nullable?: boolean; description?: string }
  | { type: "integer" | "number" | "boolean"; nullable?: boolean; description?: string }
  | { type: "array"; items: ResponseSchema; nullable?: boolean; description?: string }
  | {
      type: "object";
      properties: Record<string, ResponseSchema>;
      required?: string[];
      nullable?: boolean;
      description?: string;
    };

export type AIRequest = {
  /** Stable operation name, e.g. "event-clustering". */
  operation: string;
  /** Versioned prompt identifier, e.g. "event-clustering-v1". */
  promptVersion: string;
  systemInstruction: string;
  prompt: string;
  responseSchema: ResponseSchema;
};

export type StructuredInput = AIRequest;
export type SummaryInput = AIRequest;

export type AIUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCost: string | null;
};

export type AIResult = {
  /** Parsed JSON returned by the model. Untrusted: callers must validate it. */
  output: unknown;
  provider: string;
  model: string;
  latencyMs: number;
  usage: AIUsage;
};

export type StructuredResult = AIResult;
export type SummaryResult = AIResult;

export interface AIProvider {
  readonly name: string;
  readonly model: string;
  generateStructured(input: StructuredInput): Promise<StructuredResult>;
  generateSummary(input: SummaryInput): Promise<SummaryResult>;
}

export type AIErrorCode =
  | "AI_NOT_CONFIGURED"
  | "AI_AUTH_ERROR"
  | "AI_BAD_REQUEST"
  | "AI_MODEL_NOT_FOUND"
  | "AI_RATE_LIMITED"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_TIMEOUT"
  | "AI_NETWORK_ERROR"
  | "AI_INVALID_RESPONSE"
  | "AI_INVALID_OUTPUT";

const TRANSIENT_CODES: ReadonlySet<AIErrorCode> = new Set([
  "AI_RATE_LIMITED",
  "AI_PROVIDER_UNAVAILABLE",
  "AI_TIMEOUT",
  "AI_NETWORK_ERROR",
]);

/**
 * Stable internal AI error. Messages are generic on purpose: they never carry
 * the provider's raw payload, request headers, or credentials.
 */
export class AIProviderError extends Error {
  readonly transient: boolean;

  constructor(
    readonly code: AIErrorCode,
    message: string,
    readonly options: { retryAfterMs?: number; latencyMs?: number } = {},
  ) {
    super(message);
    this.name = "AIProviderError";
    this.transient = TRANSIENT_CODES.has(code);
  }
}

/** Invalid/malformed model output: retried a bounded number of times, never forever. */
export function isInvalidOutputError(error: unknown): boolean {
  return (
    error instanceof AIProviderError && (error.code === "AI_INVALID_RESPONSE" || error.code === "AI_INVALID_OUTPUT")
  );
}

export function emptyUsage(): AIUsage {
  return { inputTokens: null, outputTokens: null, totalTokens: null, estimatedCost: null };
}
