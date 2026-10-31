import { AUDIT_AREAS, auditEntries, type AuditArea } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { parseIsoParam } from '../_lib/iso-date';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

function areaParam(raw: string | null): AuditArea | undefined {
  if (!raw) return undefined;
  if ((AUDIT_AREAS as readonly string[]).includes(raw)) return raw as AuditArea;
  throw new ScoutError({
    slug: 'validation',
    status: 400,
    title: 'Check the request.',
    errors: [{ path: 'area', message: `Area must be one of ${AUDIT_AREAS.join(', ')}.` }],
  });
}

/**
 * The workspace's audit log, newest first: `q` (action, target, IP, or a person or key by name),
 * `area`, `actor_id` (who), `from`, `to`, `cursor` and `limit`. Each entry has its area and the names
 * behind the actor and key ids.
 */
export const GET = v1Route({ permission: 'audit:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  return auditEntries(ctx, {
    q: p.get('q') ?? undefined,
    area: areaParam(p.get('area')),
    actorId: p.get('actor_id') || undefined,
    from: parseIsoParam(p.get('from'), 'from'),
    to: parseIsoParam(p.get('to'), 'to'),
    cursor: p.get('cursor') || undefined,
    limit: pageLimit(url),
  });
});
