import type { Adapter } from '@/modules/integrations';

export type CompleteRequest = {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  /** JSON schema of the required output (closed objects). */
  jsonSchema: object;
  /** Ask the provider to cache the system prompt. */
  cacheSystem?: boolean;
  /** Mock adapter only: the output the task's `mock` function produced. Live adapters ignore it. */
  mockOutput?: unknown;
  /** Aborted when the caller (a worker job) runs past its time limit. Live adapters pass it to the request. */
  signal?: AbortSignal;
};

export type CompleteResult = {
  json: unknown;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};

/** What the AI runner needs from Claude. The live implementation lands in R1. */
export interface AnthropicAdapter extends Adapter {
  complete(req: CompleteRequest): Promise<CompleteResult>;
}
