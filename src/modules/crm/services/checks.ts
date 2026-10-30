import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { getAccount } from '@/modules/accounts';
import { gateway } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { log } from '@/platform/log';
import { enqueueJob, publish } from '@/platform/events/outbox';
import type { CrmAdapter } from '../contracts/adapter';
import { companyChecked } from '../contracts/events';
import { companyCheckJob } from '../contracts/jobs';
import type { CompanyLifecycle } from '../contracts/types';
import { companyCheck, handoff, link } from '../db/schema';
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
    await syncOwners(ctx).catch((e: unknown) => {
      // A token that can't read owners (409) is expected; anything else is worth a line in the log.
      if (!(e instanceof ScoutError && e.status === 409)) log.warn({ err: (e as Error).message }, 'crm: owner roster sync failed during a company check');
    });
  }
  return (await ownerName(ctx, system, ownerId)) ?? `HubSpot owner ${ownerId}`;
}

const normalDomain = (d: string) => d.trim().toLowerCase();

/**
 * Asks the CRM about a domain (Ruling 11). The newest stored check for that domain younger than 24 hours is
 * returned with no CRM call; otherwise the CRM is called.
 */
export async function lookupCompany(ctx: ModuleContext, domain: string, opts: { now?: Date } = {}): Promise<CompanyCheck> {
  const system = await crmSystem(ctx);
  return (await lookup(ctx, system, normalDomain(domain), opts.now ?? new Date())).check;
}

async function lookup(ctx: ModuleContext, system: string, domain: string, now: Date): Promise<{ check: CompanyCheck; fresh: boolean }> {
  const [stored] = await ctx.tx
    .select()
    .from(companyCheck)
    .where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.system, system), eq(companyCheck.domain, domain), gt(companyCheck.checkedAt, new Date(now.getTime() - CHECK_TTL_MS))))
    .orderBy(desc(companyCheck.checkedAt))
    .limit(1);
  if (stored) return { check: toCheck(stored), fresh: false };
  const found = await gateway.call(ctx, system, 'findCompany', (a) => (a as CrmAdapter).findCompany({ domain }), {
    module: 'crm',
    requestSummary: { domain },
  });
  const check: CompanyCheck = {
    accountId: null,
    system,
    exists: found !== null,
    companyExternalId: found?.externalId ?? null,
    ownerExternalId: found?.ownerExternalId ?? null,
    ownerName: await nameOf(ctx, system, found?.ownerExternalId ?? null),
    lifecycle: found ? lifecycleOf(found.lifecycle, found.deals) : 'none',
    openDeals: found?.openDeals ?? 0,
    checkedAt: now,
  };
  // Kept under a key of its own, so a lookup that has no account still reuses it for 24 hours.
  const values = {
    domain,
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
    .values({ tenantId: ctx.tenantId, accountId: `domain:${domain}`, system, ...values })
    .onConflictDoUpdate({ target: [companyCheck.tenantId, companyCheck.accountId, companyCheck.system], set: values });
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
  const domain = normalDomain(account.domain);
  const [own] = await ctx.tx
    .select()
    .from(companyCheck)
    .where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.accountId, accountId), eq(companyCheck.system, system)));
  if (own && own.domain === domain && now.getTime() - own.checkedAt.getTime() < CHECK_TTL_MS) return toCheck(own);

  const { check } = await lookup(ctx, system, domain, now);
  const values = {
    domain,
    exists: check.exists,
    companyExternalId: check.companyExternalId,
    ownerExternalId: check.ownerExternalId,
    ownerName: check.ownerName,
    lifecycle: check.lifecycle,
    openDeals: check.openDeals,
    checkedAt: check.checkedAt,
  };
  await ctx.tx
    .insert(companyCheck)
    .values({ tenantId: ctx.tenantId, accountId, system, ...values })
    .onConflictDoUpdate({ target: [companyCheck.tenantId, companyCheck.accountId, companyCheck.system], set: values });
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
  return { ...check, accountId };
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

/**
 * Queues a check for an account that has a domain. A changed domain drops the old check, and the company link
 * that check made unless a handoff has completed for the account (those links stay), so the edit does not
 * leave two company links.
 */
export async function queueCompanyCheck(ctx: ModuleContext, accountId: string, domain: string | null, opts: { domainChanged?: boolean } = {}): Promise<void> {
  if (opts.domainChanged) {
    const old = await ctx.tx.select().from(companyCheck).where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.accountId, accountId)));
    const [done] = await ctx.tx
      .select({ id: handoff.id })
      .from(handoff)
      .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.accountId, accountId), eq(handoff.status, 'completed')))
      .limit(1);
    if (!done) {
      for (const o of old) {
        if (!o.companyExternalId) continue;
        await ctx.tx
          .delete(link)
          .where(and(eq(link.tenantId, ctx.tenantId), eq(link.scoutType, 'account'), eq(link.scoutId, accountId), eq(link.system, o.system), eq(link.externalId, o.companyExternalId)));
      }
    }
    await ctx.tx.delete(companyCheck).where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.accountId, accountId)));
  }
  if (!domain) return;
  await enqueueJob(ctx, companyCheckJob, { accountId });
}
