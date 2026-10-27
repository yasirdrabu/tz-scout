import { ScoutError } from '@/platform/errors';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const bad = (path: string, message: string) =>
  new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path, message }] });

export function encodeCursor(values: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

/** The values `encodeCursor` was given. Null when no cursor was sent; a bad one is a 400. */
export function decodeCursor(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === '') return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // falls through to the error below
  }
  throw bad('cursor', 'That cursor is not valid.');
}

/** `?limit=`: 50 by default, 1 to 200. */
export function pageLimit(url: URL): number {
  const raw = url.searchParams.get('limit');
  if (raw === null) return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1 || n > MAX_LIMIT) throw bad('limit', 'Limit must be between 1 and 200.');
  return n;
}

/** Pass up to `limit + 1` rows: the extra one only says there is another page. */
export function page<T>(rows: T[], limit: number, cursorOf: (row: T) => Record<string, unknown>) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}
