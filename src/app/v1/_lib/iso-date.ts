import { ScoutError } from '@/platform/errors';

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))?$/;

/** A query parameter that is an ISO date (start of that day, UTC) or a datetime with an offset. Empty or missing is undefined; anything else is a 400 naming `path`. */
export function parseIsoParam(raw: string | null, path: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  if (!ISO.test(raw) || Number.isNaN(d.getTime())) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path, message: 'Use a date like 2026-10-01 or a date and time like 2026-10-01T09:00:00Z.' }] });
  }
  return d;
}
