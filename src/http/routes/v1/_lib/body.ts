import type { ZodType } from 'zod';
import { ScoutError } from '@/platform/errors';

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Reads the JSON body and checks it against a strict schema (unknown fields are a 400). Returns the
 * fields with their top-level keys in camelCase, the way the services expect them.
 */
export async function parseBody<T = Record<string, unknown>>(req: Request, schema: ZodType): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Send a JSON body.' });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: 'Check the request.',
      errors: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.code === 'unrecognized_keys' ? `Unknown field: ${i.keys.join(', ')}.` : i.message,
      })),
    });
  }
  return Object.fromEntries(Object.entries(parsed.data as object).map(([k, v]) => [camel(k), v])) as T;
}
