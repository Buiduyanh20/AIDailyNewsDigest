import { AIProviderError, isInvalidOutputError } from "./provider.js";

export type RetryPolicy = {
  /** Total attempts allowed for transient failures (timeout, 429, 5xx, network). */
  maxTransientAttempts: number;
  /** Total attempts allowed when the model returns malformed/invalid output. */
  maxInvalidOutputAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
};

export const DEFAULT_AI_RETRY_POLICY: RetryPolicy = {
  maxTransientAttempts: 3,
  maxInvalidOutputAttempts: 2,
  baseDelayMs: 1_000,
  maxDelayMs: 15_000,
};

export type AttemptOutcome<T> =
  | { attemptNumber: number; ok: true; value: T }
  | { attemptNumber: number; ok: false; error: unknown };

export type RetryHooks = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Called after every attempt (success or failure) so it can be recorded. */
  onAttempt?: (outcome: AttemptOutcome<unknown>) => Promise<void>;
};

/** Upper bound for a provider-requested wait (e.g. Gemini RetryInfo for per-minute quotas). */
export const MAX_PROVIDER_RETRY_AFTER_MS = 60_000;

/**
 * Exponential backoff with full jitter. A provider-requested wait (Retry-After /
 * RetryInfo) is honoured even above maxDelayMs — retrying earlier would only hit
 * the same per-minute quota again — but is itself bounded.
 */
export function backoffDelay(policy: RetryPolicy, retryIndex: number, random: () => number, retryAfterMs?: number): number {
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retryIndex);
  const jittered = Math.round(exponential / 2 + random() * (exponential / 2));
  return Math.max(jittered, Math.min(retryAfterMs ?? 0, MAX_PROVIDER_RETRY_AFTER_MS));
}

/**
 * Runs an AI call with bounded retries. Transient provider errors back off;
 * invalid output is retried at most `maxInvalidOutputAttempts` times; every
 * other error (auth, bad request, missing model, config) fails immediately.
 */
export async function runWithAiRetry<T>(
  call: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_AI_RETRY_POLICY,
  hooks: RetryHooks = {},
): Promise<T> {
  const sleep = hooks.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = hooks.random ?? Math.random;
  let transientFailures = 0;
  let invalidFailures = 0;
  let attemptNumber = 0;

  for (;;) {
    attemptNumber += 1;
    try {
      const value = await call();
      await hooks.onAttempt?.({ attemptNumber, ok: true, value });
      return value;
    } catch (error) {
      await hooks.onAttempt?.({ attemptNumber, ok: false, error });

      if (error instanceof AIProviderError && error.transient) {
        transientFailures += 1;
        if (transientFailures >= policy.maxTransientAttempts) throw error;
        await sleep(backoffDelay(policy, transientFailures - 1, random, error.options.retryAfterMs));
        continue;
      }
      if (isInvalidOutputError(error)) {
        invalidFailures += 1;
        if (invalidFailures >= policy.maxInvalidOutputAttempts) throw error;
        continue;
      }
      throw error;
    }
  }
}
