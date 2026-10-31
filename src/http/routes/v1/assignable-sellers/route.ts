import { assignableSellers } from '@/modules/routing';
import { v1Route } from '../_lib/v1-route';

/** The Assign dialog's AE cards for `account_ids` (repeated or comma separated), with the "Best match" by Decision 8. */
export const GET = v1Route({ permission: 'assign:act', peopleOnly: true }, async (req, _principal, ctx) => {
  const ids = new URL(req.url).searchParams
    .getAll('account_ids')
    .flatMap((s) => s.split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  return assignableSellers(ctx, ids);
});
