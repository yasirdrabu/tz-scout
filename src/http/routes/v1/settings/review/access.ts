import { can, type Principal } from '@/modules/tenancy';
import { ScoutError } from '@/platform/errors';

/**
 * Reading the review statuses and reasons: the dialogs that pick them need `review:act` (send back,
 * decline at review) or `assignments:respond` (a seller's decline); the editor needs `settings:manage`.
 * Returns whether the caller gets the tenant-wide counts, which only the editor shows.
 */
export function canReadReviewLists(principal: Principal): { counts: boolean } {
  const counts = can(principal, 'settings:manage');
  if (!counts && !can(principal, 'review:act') && !can(principal, 'assignments:respond')) {
    throw new ScoutError({ slug: 'forbidden', status: 403, title: 'Forbidden', detail: 'You need review:act, assignments:respond or settings:manage.' });
  }
  return { counts };
}
