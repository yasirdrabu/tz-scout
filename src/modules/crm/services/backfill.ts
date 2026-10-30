import { and, eq } from 'drizzle-orm';
import { getAccounts, listAccountIds, listExternalIds } from '@/modules/accounts';
import type { ModuleContext } from '@/platform/context';
import { companyCheck } from '../db/schema';
import { queueCompanyCheck } from './checks';
import { linkExternalIds } from './links';
import { crmSystem } from './owners';

/**
 * Brings a tenant built before R1c up to date: queues a company check for every account with a domain and no check,
 * and links accounts and people from the HubSpot ids they already carry as aliases. Safe to run again: an account with
 * a check is skipped, and a link is an upsert. Background context only.
 */
export async function backfillCrm(ctx: ModuleContext): Promise<void> {
  const system = await crmSystem(ctx);
  const checked = new Set(
    (await ctx.tx.select({ accountId: companyCheck.accountId }).from(companyCheck).where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.system, system)))).map((r) => r.accountId),
  );
  let afterId: string | undefined;
  for (;;) {
    const page = await listAccountIds(ctx, { afterId });
    if (page.ids.length === 0) break;
    for (const a of await getAccounts(ctx, page.ids)) {
      if (a.domain && !checked.has(a.id)) await queueCompanyCheck(ctx, a.id, a.domain);
    }
    if (!page.nextAfterId) break;
    afterId = page.nextAfterId;
  }

  for (const row of await listExternalIds(ctx)) {
    if (row.system !== system) continue;
    await linkExternalIds(ctx, { accountId: row.accountId, personId: row.personId ?? undefined, externalIds: [{ system: row.system, id: row.id }] });
  }
}
