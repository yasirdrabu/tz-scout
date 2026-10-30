import { and, eq, inArray, sql } from 'drizzle-orm';
import type { MergeGuard } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { activity, companyCheck, deal, handoff, link } from '../db/schema';
import { lockAccount } from './handoff';

/** The copy a refused merge shows (record-links-and-field-mapping CRM-E7-S1-AC2). */
export const LINKED_COMPANIES_REASON = 'Two HubSpot companies are linked';

const companyLinks = (ctx: ModuleContext, accountId: string) =>
  ctx.tx
    .select({ system: link.system, externalId: link.externalId })
    .from(link)
    .where(and(eq(link.tenantId, ctx.tenantId), eq(link.scoutType, 'account'), eq(link.scoutId, accountId)));

/** Refuses a merge when both accounts are linked to different companies in the same CRM. */
export const crmMergeGuard: MergeGuard = {
  async check(ctx, survivorId, mergedId) {
    const [a, b] = await Promise.all([companyLinks(ctx, survivorId), companyLinks(ctx, mergedId)]);
    const clash = a.some((x) => b.some((y) => x.system === y.system && x.externalId !== y.externalId));
    return clash ? { allowed: false, reason: LINKED_COMPANIES_REASON } : { allowed: true };
  },
};

/**
 * `accounts.account.merged`: the merged account's links, handoffs, deals, activities and company checks move to the
 * survivor. Follow-through is keyed by handoff, so it follows. A row the survivor already has (same unique key) is
 * dropped from the merged side. If the guard was bypassed and two companies stay linked, both links are kept.
 */
export async function moveCrmToSurvivor(ctx: ModuleContext, survivorId: string, mergedId: string): Promise<void> {
  for (const id of [survivorId, mergedId].sort()) await lockAccount(ctx, id);
  const t = ctx.tenantId;

  await ctx.tx.execute(sql`
    delete from crm.link m
    where m.tenant_id = ${t} and m.scout_type in ('account', 'note') and m.scout_id = ${mergedId}
      and exists (select 1 from crm.link s where s.tenant_id = m.tenant_id and s.system = m.system and s.scout_type = m.scout_type
                  and s.scout_id = ${survivorId} and s.external_id = m.external_id)`);
  await ctx.tx
    .update(link)
    .set({ scoutId: survivorId })
    .where(and(eq(link.tenantId, t), inArray(link.scoutType, ['account', 'note']), eq(link.scoutId, mergedId)));

  await ctx.tx.execute(sql`
    delete from crm.company_check m
    where m.tenant_id = ${t} and m.account_id = ${mergedId}
      and exists (select 1 from crm.company_check s where s.tenant_id = m.tenant_id and s.account_id = ${survivorId} and s.system = m.system)`);
  await ctx.tx.update(companyCheck).set({ accountId: survivorId }).where(and(eq(companyCheck.tenantId, t), eq(companyCheck.accountId, mergedId)));

  await ctx.tx.update(handoff).set({ accountId: survivorId }).where(and(eq(handoff.tenantId, t), eq(handoff.accountId, mergedId)));
  await ctx.tx.update(deal).set({ accountId: survivorId }).where(and(eq(deal.tenantId, t), eq(deal.accountId, mergedId)));
  await ctx.tx.update(activity).set({ accountId: survivorId }).where(and(eq(activity.tenantId, t), eq(activity.accountId, mergedId)));
}
