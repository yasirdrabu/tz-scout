import { listWaiting } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';
import { withoutContacts } from '../_lib/intake';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

const REASONS = ['needs_website', 'needs_company', 'possible_duplicate'] as const;
type Reason = (typeof REASONS)[number];

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, principal, ctx) => {
  const url = new URL(req.url);
  const reason = url.searchParams.get('reason');
  if (reason && !(REASONS as readonly string[]).includes(reason)) {
    throw new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path: 'reason', message: `Use one of ${REASONS.join(', ')}.` }] });
  }
  const page = await listWaiting(ctx, {
    reason: (reason as Reason | null) ?? undefined,
    cursor: url.searchParams.get('cursor') || undefined,
    limit: pageLimit(url),
  });
  return can(principal, 'people:read') ? page : withoutContacts(page);
});
