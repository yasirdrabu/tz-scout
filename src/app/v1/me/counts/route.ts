import { countNewAssignments, countQueue } from '@/modules/routing';
import { can } from '@/modules/tenancy';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** The nav badges in one call: each count is null without its permission. */
export const GET = v1Route({ peopleOnly: true }, async (_req, principal, ctx) => ({
  reviewQueue: can(principal, 'review:act') ? await countQueue(ctx) : null,
  newAssignments: can(principal, 'assignments:respond') ? await countNewAssignments(ctx) : null,
}));
