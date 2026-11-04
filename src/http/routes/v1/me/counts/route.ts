import { myStepCounts } from '@/modules/playbooks';
import { countNewAssignments, countQueue } from '@/modules/routing';
import { can } from '@/modules/tenancy';
import { v1Route } from '../../_lib/v1-route';

/** The nav badges in one call: each count is null without its permission. The step counts are the caller's own open steps. */
export const GET = v1Route({ peopleOnly: true }, async (_req, principal, ctx) => {
  const steps = can(principal, 'playbooks:read') ? await myStepCounts(ctx) : null;
  return {
    reviewQueue: can(principal, 'review:act') ? await countQueue(ctx) : null,
    newAssignments: can(principal, 'assignments:respond') ? await countNewAssignments(ctx) : null,
    nextStepsDueToday: steps?.dueToday ?? null,
    nextStepsOverdue: steps?.overdue ?? null,
  };
});
