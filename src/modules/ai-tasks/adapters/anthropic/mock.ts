import { registerAdapter } from '@/modules/integrations';
import type { AnthropicAdapter, CompleteRequest } from './contract';

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; anyOf?: Schema[]; const?: unknown };

/** Smallest value that satisfies a JSON schema (as written by z.toJSONSchema). */
export function minimalFor(s: Schema): unknown {
  if (s.const !== undefined) return s.const;
  if (s.enum?.length) return s.enum[0];
  if (s.anyOf?.length) return minimalFor(s.anyOf[0]!);
  const type = Array.isArray(s.type) ? s.type.find((t) => t !== 'null') ?? 'null' : s.type;
  switch (type) {
    case 'object':
      return Object.fromEntries((s.required ?? []).map((k) => [k, minimalFor(s.properties?.[k] ?? {})]));
    case 'array':
      return [];
    case 'string':
      return '';
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}

/** Deterministic: the task's own sample output when given, else the smallest valid object. */
export const anthropicMock: AnthropicAdapter = {
  async test() {
    return { ok: true, message: 'Sample data is working.' };
  },
  async complete(req: CompleteRequest) {
    return {
      json: req.mockOutput !== undefined ? req.mockOutput : minimalFor(req.jsonSchema as Schema),
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: 10,
      cacheReadTokens: 0,
    };
  },
};

export const registerAnthropicAdapter = (): void => registerAdapter('anthropic', { mock: () => anthropicMock });
