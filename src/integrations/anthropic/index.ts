// Claude. Every AI task calls complete() through src/ai/run.ts, which logs the run.
// The mock returns the task's own deterministic mock output, so the prompt, parse, validate and log
// path is identical in both modes.

import Anthropic from "@anthropic-ai/sdk";
import { modeOf, NotConnectedError } from "../mode";

export type CompletionRequest = {
  system: string;
  user: string;
  /** JSON schema the response must match (structured output). */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Used only by the mock: the JSON it should return. */
  mockResponse: unknown;
};

export type Completion = { json: unknown; model: string; inputTokens: number; outputTokens: number };

export interface AnthropicAdapter {
  readonly mode: "mock" | "live";
  readonly model: string;
  complete(req: CompletionRequest): Promise<Completion>;
}

const approxTokens = (s: string) => Math.ceil(s.length / 4);

const mock: AnthropicAdapter = {
  mode: "mock",
  model: "mock",
  async complete(req) {
    await new Promise((r) => setTimeout(r, 250));
    const text = JSON.stringify(req.mockResponse);
    return { json: req.mockResponse, model: "mock", inputTokens: approxTokens(req.system + req.user), outputTokens: approxTokens(text) };
  },
};

function createLive(): AnthropicAdapter {
  const model = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
  let client: Anthropic | null = null;
  return {
    mode: "live",
    model,
    async complete(req) {
      if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) throw new NotConnectedError("anthropic", "set ANTHROPIC_API_KEY");
      client ??= new Anthropic();
      const response = await client.messages.create({
        model,
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: req.schema } },
      });
      if (response.stop_reason === "refusal") throw new Error("Claude declined this request.");
      if (response.stop_reason === "max_tokens") throw new Error("Claude ran out of room before finishing. Try again with less input.");
      const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { json: JSON.parse(text), model: response.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
    },
  };
}

export function anthropicAdapter(): AnthropicAdapter {
  return modeOf("anthropic") === "live" ? createLive() : mock;
}
