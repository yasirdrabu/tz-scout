import { ScoutError } from '@/platform/errors';

export const notFound = () => new ScoutError({ slug: 'not-found', status: 404, title: 'Not found.' });

/**
 * The id segment that follows `after` in the request path, split at ':' into id and action, for
 * example `/api/v1/offers/off_01J:approve` gives `{ id: 'off_01J', action: 'approve' }`.
 * A path without that segment, or with a malformed one, is a 404.
 */
export function idAndAction(req: Request, after: string): { id: string; action: string | null } {
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const raw = parts[parts.indexOf(after) + 1];
  if (!raw) throw notFound();
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw notFound();
  }
  const [id, action, ...rest] = decoded.split(':');
  if (!id || rest.length > 0) throw notFound();
  return { id, action: action ?? null };
}
