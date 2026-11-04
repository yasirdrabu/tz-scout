import { pendingPlaybookNames } from '@/modules/playbooks';
import { getAccountReview } from '@/modules/routing';
import { can } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/**
 * The account's review: status with who and when, stage dates, the open assignment with names, sources and version.
 * With `playbooks:read`, the open assignment also carries `template_id`, `no_playbook` and `playbook_name`: the playbook
 * the assigner picked, else the lead offer's playbook for the account's tier (null when none).
 */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const review = await getAccountReview(ctx, id);
  const a = review.currentAssignment;
  if (!a) return review;
  const readPlaybooks = can(principal, 'playbooks:read');
  const names = readPlaybooks
    ? await pendingPlaybookNames(ctx, [{ key: a.id, accountId: review.accountId, offerId: review.leadOffer?.offerId ?? review.bestOfferId, templateId: a.templateId, noPlaybook: a.noPlaybook }])
    : new Map<string, string | null>();
  return {
    ...review,
    currentAssignment: { ...a, templateId: readPlaybooks ? a.templateId : null, noPlaybook: readPlaybooks ? a.noPlaybook : null, playbookName: names.get(a.id) ?? null },
  };
});
