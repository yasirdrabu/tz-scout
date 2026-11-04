import { pendingPlaybookNames } from '@/modules/playbooks';
import { ASSIGNMENT_STATUSES, listAssignments } from '@/modules/routing';
import { ScoutError } from '@/platform/errors';
import { can, requirePermission } from '@/modules/tenancy';
import { planFields } from '../_lib/next-step';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

/**
 * REV-E2-S2: `mine` is the caller's own assignments (`assignments:respond`). Without it the list crosses
 * accounts and shows leaders' notes and decline reasons, so it needs `assign:act` or `review:act`.
 * A page can be short with a `next_cursor`; follow it.
 * Playbooks fill `next_step` (an accepted row's open plan) and `playbook_name` (a pending row's is the one that will start).
 */
export const GET = v1Route({ peopleOnly: true }, async (req, principal, ctx) => {
  const url = new URL(req.url);
  const bad = (path: string, message: string) => new ScoutError({ slug: 'validation', status: 400, title: message, errors: [{ path, message }] });
  const rawMine = url.searchParams.get('mine');
  if (rawMine !== null && !['true', 'false', '1', '0'].includes(rawMine)) throw bad('mine', 'Use mine=true or mine=false.');
  const mine = rawMine === 'true' || rawMine === '1';
  const status = url.searchParams.get('status') || undefined;
  if (status && !(ASSIGNMENT_STATUSES as readonly string[]).includes(status)) throw bad('status', 'Use one of: pending, accepted, declined, withdrawn, replaced.');
  if (mine) requirePermission(principal, 'assignments:respond');
  else if (!can(principal, 'assign:act')) requirePermission(principal, 'review:act');
  const page = await listAssignments(ctx, { mine, status, cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url) });
  const plans = await planFields(ctx, principal, page.data.map((r) => r.accountId));
  const pending = await pendingPlaybookNames(
    ctx,
    (can(principal, 'playbooks:read') ? page.data : []).filter((r) => r.status === 'pending').map((r) => ({ key: r.id, accountId: r.accountId, offerId: r.offerId, templateId: r.templateId, noPlaybook: r.noPlaybook })),
  );
  const readPlaybooks = can(principal, 'playbooks:read');
  return {
    ...page,
    data: page.data.map((r) => {
      const plan = r.status === 'accepted' ? plans.get(r.accountId) : undefined;
      return { ...r, templateId: readPlaybooks ? r.templateId : null, noPlaybook: readPlaybooks ? r.noPlaybook : null, nextStep: plan?.nextStep ?? null, playbookName: r.status === 'pending' ? (pending.get(r.id) ?? null) : (plan?.playbookName ?? null) };
    }),
  };
});
