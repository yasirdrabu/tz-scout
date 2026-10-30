import { and, eq, inArray } from 'drizzle-orm';
import { gateway } from '@/modules/integrations';
import type { ModuleContext } from '@/platform/context';
import { publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { log } from '@/platform/log';
import { DEALS_PAGE_LIMIT, type CrmAdapter, type CrmDeal, type ListedDeal } from '../contracts/adapter';
import { dealChanged } from '../contracts/events';
import type { CompanyLifecycle } from '../contracts/types';
import { companyCheck, crmSetting, deal, link } from '../db/schema';
import { lifecycleOf } from './checks';
import { lockAccount } from './handoff';
import { recordLink } from './links';
import { crmSystem } from './owners';

/** A poll reads this much before its last high-water mark, so an update at the boundary is not missed. */
export const DEALS_OVERLAP_MS = 5 * 60 * 1000;
/** A tenant's first poll looks this far back. */
export const DEALS_FIRST_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * `none`, `open_deal` or `customer` (Ruling 12): customer when the stored CRM check says customer or any cached deal is won,
 * open deal when any cached deal is open, else none.
 */
export async function companyLifecycle(
  ctx: ModuleContext,
  accountId: string,
  /** A check that just called the CRM: its raw stage and deals are newer than anything stored, and cover deals not cached yet. */
  fresh?: { crmLifecycle: string | null; freshDeals?: { status: string }[] },
): Promise<CompanyLifecycle> {
  const system = await crmSystem(ctx);
  const [check] = await ctx.tx
    .select({ crmLifecycle: companyCheck.crmLifecycle })
    .from(companyCheck)
    .where(and(eq(companyCheck.tenantId, ctx.tenantId), eq(companyCheck.accountId, accountId), eq(companyCheck.system, system)));
  const cached = await ctx.tx.select({ status: deal.status }).from(deal).where(and(eq(deal.tenantId, ctx.tenantId), eq(deal.accountId, accountId)));
  return lifecycleOf(fresh ? fresh.crmLifecycle : (check?.crmLifecycle ?? null), fresh?.freshDeals ?? cached);
}

const withCompany = (deals: ListedDeal[]): CrmDeal[] => deals.filter((d): d is CrmDeal => d.companyExternalId !== null);

/**
 * Records deals read from the CRM (Ruling 18). A deal whose company has no `account` link is ignored. A new deal
 * publishes its status; a known one publishes `crm.deal.changed` only when status or amount changed. Never writes to the CRM.
 * Returns how many events were published.
 */
export async function applyDeals(ctx: ModuleContext, deals: CrmDeal[], now: Date, system?: string): Promise<number> {
  if (deals.length === 0) return 0;
  const sys = system ?? (await crmSystem(ctx));
  const links = await ctx.tx
    .select({ scoutId: link.scoutId, externalId: link.externalId })
    .from(link)
    .where(
      and(
        eq(link.tenantId, ctx.tenantId),
        eq(link.scoutType, 'account'),
        eq(link.system, sys),
        inArray(link.externalId, [...new Set(deals.map((d) => d.companyExternalId))]),
      ),
    )
    .orderBy(link.lastSyncedAt, link.id);
  const accountOf = new Map<string, string>();
  for (const l of links) if (!accountOf.has(l.externalId)) accountOf.set(l.externalId, l.scoutId);

  // Account locks are taken in one order, so two polls cannot wait on each other.
  const mine = deals
    .filter((d) => accountOf.has(d.companyExternalId))
    .sort((a, b) => accountOf.get(a.companyExternalId)!.localeCompare(accountOf.get(b.companyExternalId)!));
  let published = 0;
  for (const d of mine) {
    const accountId = accountOf.get(d.companyExternalId)!;
    await lockAccount(ctx, accountId);
    const [known] = await ctx.tx
      .select()
      .from(deal)
      .where(and(eq(deal.tenantId, ctx.tenantId), eq(deal.system, sys), eq(deal.externalId, d.externalId)));
    const values = {
      accountId,
      name: d.name,
      stage: d.stage,
      status: d.status,
      amountCents: d.amountCents,
      currency: d.currency,
      openedAt: d.openedAt ? new Date(d.openedAt) : null,
      closedAt: d.closedAt ? new Date(d.closedAt) : null,
      syncedAt: now,
    };
    if (known) {
      await ctx.tx.update(deal).set(values).where(eq(deal.id, known.id));
    } else {
      const id = newId('dea');
      await ctx.tx.insert(deal).values({ id, tenantId: ctx.tenantId, system: sys, externalId: d.externalId, ...values });
      await recordLink(ctx, { scoutType: 'deal', scoutId: id, system: sys, externalId: d.externalId });
    }
    if (known && known.status === d.status && known.amountCents === d.amountCents) continue;
    await publish(
      ctx,
      dealChanged,
      {
        accountId,
        system: sys,
        dealExternalId: d.externalId,
        status: d.status,
        previousStatus: (known?.status as CrmDeal['status'] | undefined) ?? null,
        stage: d.stage,
        amountCents: d.amountCents,
        currency: d.currency,
        openedAt: d.openedAt,
        closedAt: d.closedAt,
        companyLifecycle: await companyLifecycle(ctx, accountId),
        observedAt: now.toISOString(),
      },
      { type: 'account', id: accountId },
    );
    published++;
  }
  return published;
}

/**
 * The `crm.deals.poll` job (Ruling 18): one `listDeals({ changedSince })` call from the last high-water mark
 * (`crm.setting.deals_polled_until`, less a 5 minute overlap; a day back the first time), then `applyDeals`.
 * The mark moves to `now` only when the whole poll succeeded. A full page (`DEALS_PAGE_LIMIT`) may have more after it, so
 * the mark then moves only to the last deal's modified time, and the next poll reads on from there (final review I4).
 * Returns how many events were published.
 */
export async function pollDeals(ctx: ModuleContext, now: Date): Promise<number> {
  const system = await crmSystem(ctx);
  const [setting] = await ctx.tx.select({ until: crmSetting.dealsPolledUntil }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  const from = setting?.until ? new Date(setting.until.getTime() - DEALS_OVERLAP_MS) : new Date(now.getTime() - DEALS_FIRST_LOOKBACK_MS);
  const found = await gateway.call(ctx, system, 'listDeals', (a) => (a as CrmAdapter).listDeals({ changedSince: from.toISOString() }), {
    module: 'crm',
    requestSummary: { changedSince: from.toISOString() },
  });
  const published = await applyDeals(ctx, withCompany(found), now, system);
  const last = found.length >= DEALS_PAGE_LIMIT ? found[found.length - 1]?.modifiedAt : null;
  const until = last ? new Date(last) : now;
  if (last) log.warn({ tenantId: ctx.tenantId, read: found.length, until: last }, 'crm: deals poll read a full page; the rest comes next poll');
  await ctx.tx
    .insert(crmSetting)
    .values({ tenantId: ctx.tenantId, dealsPolledUntil: until })
    .onConflictDoUpdate({ target: crmSetting.tenantId, set: { dealsPolledUntil: until, updatedAt: now } });
  return published;
}

/** Reads one company's deals now, for `syncAccount`. */
export async function syncDeals(ctx: ModuleContext, system: string, companyExternalId: string, now: Date): Promise<number> {
  const found = await gateway.call(ctx, system, 'listDeals', (a) => (a as CrmAdapter).listDeals({ companyExternalId }), {
    module: 'crm',
    requestSummary: { companyExternalId },
  });
  return applyDeals(ctx, withCompany(found), now, system);
}
