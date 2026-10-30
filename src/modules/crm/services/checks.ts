import { and, eq, inArray } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { enqueueJob, publish } from '@/platform/events/outbox';
import type { CrmAdapter } from '../contracts/adapter';
import { companyChecked } from '../contracts/events';
import { companyCheckJob } from '../contracts/jobs';
import type { CompanyLifecycle } from '../contracts/types';
import { companyCheck } from '../db/schema';
import { recordLink } from './links';
import { crmSystem, ownerName, rosterSynced, syncOwners } from './owners';

/** A check younger than this is reused (Ruling 11). */
export const CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** Most accounts `companyChecks` answers for at once. */
export const COMPANY_CHECKS_LIMIT = 200;

export type CompanyCheck = {
  accountId: string | null;
  system: string;
  exists: boolean;
  companyExternalId: string | null;
  ownerExternalId: string | null;
  ownerName: string | null;
  lifecycle: CompanyLifecycle;
  openDeals: number;
  checkedAt: Date;
};

type Stored = typeof companyCheck.$inferSelect;

const toCheck = (r: Stored): CompanyCheck => ({
  accountId: r.accountId,
  system: r.system,
  exists: r.exists,
  companyExternalId: r.companyExternalId,
  ownerExternalId: r.ownerExternalId,
  ownerName: r.ownerName,
  lifecycle: (r.lifecycle ?? 'none') as CompanyLifecycle,
  openDeals: r.openDeals,
  checkedAt: r.checkedAt,
});

/** Customer when the CRM says so or any deal is won; open deal when any deal is open; else none (Ruling 12). */
function lifecycleOf(crmLifecycle: string | null, deals: { status: string }[]): CompanyLifecycle {
  if (crmLifecycle === 'customer' || deals.some((d) => d.status === 'won')) return 'customer';
  return deals.some((d) => d.status === 'open') ? 'open_deal' : 'none';
}

/** Names the owner from the roster, reading the roster once when it has never been read. Falls back to `HubSpot owner <id>`. */
async function nameOf(ctx: ModuleContext, system: string, ownerId: string | null): Promise<string | null> {
  if (!ownerId) return null;
  if (!(await rosterSynced(ctx, system))) {
    await syncOwners(ctx).catch(() => undefined);
  }
  return (await ownerName(ctx, system, ownerId)) ?? `HubSpot owner ${ownerId}`;
}

/**
 * Asks the CRM about a domain (Ruling 11). With `accountId`, a stored check younger than 24 hours is returned
 * and no CRM call is made; otherwise the CRM is called and, with `accountId`, the answer is stored.
 */
export async function lookupCompany(ctx: ModuleContext, domain: string, opts: { accountId?: string; now?: Date } = {}): Promise<CompanyCheck> {
  const now = opts.now ?? new Date();
  const system = await crmSystem(ctx);
  const { check } = await lookup(ctx, system, domain, opts.accountId ?? null, now);
  return check;
}

async function lookup(
  ctx: ModuleContext,
  system: string,
  domain: string,
  accountId: string | null,
  now: Date,
): Promise<{ check: CompanyCheck; fresh: boolean }> {
  if (accountId) {
    const [stored] = await ctx.tx
      .select()
      .from(companyCheck)
      .where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.accountId, accountId), eq(companyCheck.system, system)));
    if (stored && now.getTime() - stored.checkedAt.getTime() < CHECK_TTL_MS) return { check: toCheck(stored), fresh: false };
  }
  const found = await gateway.call(ctx, system, 'findCompany', (a) => (a as CrmAdapter).findCompany({ domain }), {
    module: 'crm',
    requestSummary: { domain },
  });
  const check: CompanyCheck = {
    accountId,
    system,
    exists: found !== null,
    companyExternalId: found?.externalId ?? null,
    ownerExternalId: found?.ownerExternalId ?? null,
    ownerName: await nameOf(ctx, system, found?.ownerExternalId ?? null),
    lifecycle: found ? lifecycleOf(found.lifecycle, found.deals) : 'none',
    openDeals: found?.openDeals ?? 0,
    checkedAt: now,
  };
  if (accountId) {
    const values = {
      exists: check.exists,
      companyExternalId: check.companyExternalId,
      ownerExternalId: check.ownerExternalId,
      ownerName: check.ownerName,
      lifecycle: check.lifecycle,
      openDeals: check.openDeals,
      checkedAt: now,
    };
    await ctx.tx
      .insert(companyCheck)
      .values({ tenantId: ctx.tenantId, accountId, system, ...values })
      .onConflictDoUpdate({ target: [companyCheck.tenantId, companyCheck.accountId, companyCheck.system], set: values });
  }
  return { check, fresh: true };
}

/**
 * Checks an account's company in the CRM before review. Stores the check, links a matched company and
 * publishes `crm.company.checked`. An account with no domain is not checked, and a check younger than
 * 24 hours is returned as is (no call, no event).
 */
export async function checkCompany(ctx: ModuleContext, accountId: string): Promise<CompanyCheck | null> {
  const account = await getAccount(ctx, accountId);
  if (!account?.domain) return null;
  const now = new Date();
  const system = await crmSystem(ctx);
  const { check, fresh } = await lookup(ctx, system, account.domain, accountId, now);
  if (!fresh) return check;
  if (check.companyExternalId) {
    await recordLink(ctx, { scoutType: 'account', scoutId: accountId, system, externalId: check.companyExternalId });
  }
  await publish(
    ctx,
    companyChecked,
    {
      accountId,
      system,
      exists: check.exists,
      companyExternalId: check.companyExternalId,
      ownerName: check.ownerName,
      companyLifecycle: check.lifecycle,
      observedAt: now.toISOString(),
    },
    { type: 'account', id: accountId },
  );
  return check;
}

/** The stored checks for these accounts (at most 200); accounts never checked are left out. */
export async function companyChecks(ctx: ModuleContext, accountIds: string[]): Promise<(CompanyCheck & { accountId: string })[]> {
  const ids = [...new Set(accountIds)].slice(0, COMPANY_CHECKS_LIMIT);
  if (ids.length === 0) return [];
  const system = await crmSystem(ctx);
  const rows = await ctx.tx
    .select()
    .from(companyCheck)
    .where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.system, system), inArray(companyCheck.accountId, ids)));
  return rows.map((r) => ({ ...toCheck(r), accountId: r.accountId }));
}

/** Queues a check for an account that has a domain. A changed domain drops the old check first, so the new one is not served from the cache. */
export async function queueCompanyCheck(ctx: ModuleContext, accountId: string, domain: string | null, opts: { domainChanged?: boolean } = {}): Promise<void> {
  if (opts.domainChanged) await ctx.tx.delete(companyCheck).where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.accountId, accountId)));
  if (!domain) return;
  await enqueueJob(ctx, companyCheckJob, { accountId });
}
