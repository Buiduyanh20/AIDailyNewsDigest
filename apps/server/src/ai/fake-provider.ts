import { emptyUsage, type AIProvider, type AIRequest, type AIResult } from "./provider.js";

export type FakeResponder = (request: AIRequest) => unknown | Promise<unknown>;

/**
 * Deterministic in-process AI provider for automated tests. Each call is
 * answered by a scripted responder; throwing from a responder simulates a
 * provider failure. Never calls the network.
 */
export class FakeAIProvider implements AIProvider {
  readonly name = "fake";
  readonly model = "fake-model-v1";
  readonly calls: AIRequest[] = [];

  constructor(
    private readonly responders: {
      cluster?: FakeResponder;
      summarize?: FakeResponder;
    } = {},
  ) {}

  async generateStructured(input: AIRequest): Promise<AIResult> {
    return this.respond(input, this.responders.cluster);
  }

  async generateSummary(input: AIRequest): Promise<AIResult> {
    return this.respond(input, this.responders.summarize);
  }

  callsFor(operation: string): AIRequest[] {
    return this.calls.filter((call) => call.operation === operation);
  }

  private async respond(input: AIRequest, responder: FakeResponder | undefined): Promise<AIResult> {
    this.calls.push(input);
    if (!responder) {
      throw new Error(`FakeAIProvider has no responder for ${input.operation}.`);
    }
    const output = await responder(input);
    return {
      output,
      provider: this.name,
      model: this.model,
      latencyMs: 1,
      usage: { ...emptyUsage(), inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    };
  }
}

/** Extracts the JSON payload the prompt builders embed between <input> tags. */
export function readPromptPayload<T>(request: AIRequest): T {
  const match = /<input>\s*([\s\S]*?)\s*<\/input>/.exec(request.prompt);
  if (!match?.[1]) {
    throw new Error("Prompt payload not found.");
  }
  return JSON.parse(match[1]) as T;
}
