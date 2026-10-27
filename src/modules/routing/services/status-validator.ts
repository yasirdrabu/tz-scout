import { and, eq, isNull } from 'drizzle-orm';
import type { ReviewStatusValidator } from '@/modules/intake';
import { reviewStatusDef } from '../db/schema';

/** Intake's `ReviewStatusValidator`: a source may start accounts at any active status. */
export const routingReviewStatusValidator: ReviewStatusValidator = {
  exists: async (ctx, key) => {
    const rows = await ctx.tx
      .select({ id: reviewStatusDef.id })
      .from(reviewStatusDef)
      .where(and(eq(reviewStatusDef.tenantId, ctx.tenantId), eq(reviewStatusDef.key, key), isNull(reviewStatusDef.archivedAt)))
      .limit(1);
    return rows.length > 0;
  },
};
