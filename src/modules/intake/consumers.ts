import { and, eq, sql } from 'drizzle-orm';
import { accountMerged } from '@/modules/accounts/contracts/events';
import { tenantCreated } from '@/modules/tenancy/contracts/events';
import { defineConsumer } from '@/platform/runtime/consumers';
import { seedIntakeDefaults } from './defaults';
import { arrival, warmIntro } from './db/schema';

/** Gives a new tenant its vendor sources, relationship defaults and waiting-expiry schedule. */
export const intakeTenantDefaults = defineConsumer({
  name: 'intake.tenant_defaults',
  event: tenantCreated,
  handle: async (_e, ctx) => seedIntakeDefaults(ctx),
});

/** After a merge, arrivals, warm intros and duplicate candidates that named the merged account name the survivor. */
export const intakeAccountMerged = defineConsumer({
  name: 'intake.account_merged',
  event: accountMerged,
  orderedBy: (e) => e.data.survivorId,
  handle: async ({ data: { survivorId, mergedId } }, ctx) => {
    await ctx.tx.update(arrival).set({ accountId: survivorId }).where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.accountId, mergedId)));
    await ctx.tx.update(warmIntro).set({ accountId: survivorId }).where(and(eq(warmIntro.tenantId, ctx.tenantId), eq(warmIntro.accountId, mergedId)));
    await ctx.tx.execute(sql`
      update intake.arrival set duplicate_candidates = (
        select jsonb_agg(case when c->>'accountId' = ${mergedId} then jsonb_set(c, '{accountId}', to_jsonb(${survivorId}::text)) else c end)
        from jsonb_array_elements(duplicate_candidates) c)
      where tenant_id = ${ctx.tenantId}
        and duplicate_candidates @> jsonb_build_array(jsonb_build_object('accountId', ${mergedId}::text))
    `);
  },
});
