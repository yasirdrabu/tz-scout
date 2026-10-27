import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { enqueueJob } from '@/platform/events/outbox';
import { defineJob } from '@/platform/events/registry';
import { defineJobHandler } from '@/platform/runtime/jobs';
import { account } from './db/schema';
import { applyExclusion } from './services/exclusion';
import { lockAccount } from './services/lock';

/** Accounts per message. The small page keeps account locks short, so resolves are not held up. */
export const RECHECK_PAGE_SIZE = 100;

/** Re-evaluates the exclusion rules for every account, a page at a time, after a settings change. */
export const exclusionsRecheckJob = defineJob('accounts.exclusions.recheck', z.object({ cursor: z.string().optional() }));

export const exclusionsRecheckHandler = defineJobHandler(exclusionsRecheckJob, async (e, ctx) => {
  const page = await ctx.tx
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.tenantId, ctx.tenantId), e.data.cursor ? gt(account.id, e.data.cursor) : undefined))
    .orderBy(asc(account.id))
    .limit(RECHECK_PAGE_SIZE);
  for (const { id } of page) {
    await lockAccount(ctx, id);
    await applyExclusion(ctx, id);
  }
  if (page.length === RECHECK_PAGE_SIZE) await enqueueJob(ctx, exclusionsRecheckJob, { cursor: page[page.length - 1]!.id });
});
