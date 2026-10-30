import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { leadQualified } from '../contracts/events';
import { dealsPollJob, syncJob } from '../contracts/jobs';
import { crmSetting, deal, link, webhookReceipt } from '../db/schema';
import { parseHubSpotWebhook } from '../domain/webhook';
import { crmSystem } from './owners';
import { getCrmSettings } from './settings';

/** Webhooks about deals Scout has not seen queue at most one deals poll in this long (final review I5). */
export const DEALS_POLL_COALESCE_MS = 5 * 60 * 1000;

/** Claims the tenant's deals poll request: true when none was made in the last 5 minutes (and records this one). */
async function claimDealsPoll(ctx: ModuleContext, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - DEALS_POLL_COALESCE_MS);
  const claimed = await ctx.tx
    .insert(crmSetting)
    .values({ tenantId: ctx.tenantId, dealsPollRequestedAt: now })
    .onConflictDoUpdate({
      target: crmSetting.tenantId,
      set: { dealsPollRequestedAt: now },
      setWhere: or(isNull(crmSetting.dealsPollRequestedAt), lt(crmSetting.dealsPollRequestedAt, since)),
    })
    .returning({ tenantId: crmSetting.tenantId });
  return claimed.length > 0;
}

/**
 * An inbound HubSpot webhook that the route (Task 16) has already authenticated: it found `connectionId` for this
 * tenant's HubSpot connection and checked the v3 signature, so nothing here re-checks either.
 *
 * Stores the body, then:
 * - a deal or engagement event enqueues `crm.sync` once per affected account that has a company link. A deal is
 *   matched by its stored `crm.deal` row, else by a company id in the event. An engagement that matches no account is
 *   covered by the 15 minute activity poll; a deal Scout has never seen queues one `crm.deals.poll` instead, at most
 *   one per 5 minutes (`crm.setting.deals_poll_requested_at`).
 * - a contact lifecycle event matching the qualified-lead rule publishes `crm.lead.qualified` (once per contact).
 */
export async function handleCrmWebhook(ctx: ModuleContext, connectionId: string, rawBody: string): Promise<{ syncs: number; leads: number }> {
  const receiptId = newId('whr');
  await ctx.tx.insert(webhookReceipt).values({ id: receiptId, tenantId: ctx.tenantId, connectionId, body: rawBody });
  const events = parseHubSpotWebhook(rawBody);
  const system = await crmSystem(ctx);
  const { qualifiedLeadRule: rule } = await getCrmSettings(ctx);

  const accounts = new Set<string>();
  const contacts = new Set<string>();
  let unknownDeal = false;

  const dealIds = [...new Set(events.filter((e) => e.kind === 'deal').map((e) => e.objectId))];
  const knownDeals = dealIds.length
    ? await ctx.tx
        .select({ externalId: deal.externalId, accountId: deal.accountId })
        .from(deal)
        .where(and(eq(deal.tenantId, ctx.tenantId), eq(deal.system, system), inArray(deal.externalId, dealIds)))
    : [];
  const dealAccount = new Map(knownDeals.map((d) => [d.externalId, d.accountId]));
  const companyIds = [...new Set(events.flatMap((e) => (e.companyId ? [e.companyId] : [])))];
  const companyLinks = companyIds.length
    ? await ctx.tx
        .select({ scoutId: link.scoutId, externalId: link.externalId })
        .from(link)
        .where(and(eq(link.tenantId, ctx.tenantId), eq(link.scoutType, 'account'), eq(link.system, system), inArray(link.externalId, companyIds)))
    : [];

  for (const e of events) {
    if (e.kind === 'lifecycle') {
      if (e.propertyName === rule.property && e.propertyValue === rule.value && e.contactId) contacts.add(e.contactId);
      continue;
    }
    const byDeal = e.kind === 'deal' && dealAccount.has(e.objectId) ? [dealAccount.get(e.objectId)!] : [];
    const byCompany = e.companyId ? companyLinks.filter((l) => l.externalId === e.companyId).map((l) => l.scoutId) : [];
    const found = [...byDeal, ...byCompany];
    found.forEach((a) => accounts.add(a));
    if (found.length === 0 && e.kind === 'deal') unknownDeal = true;
  }

  for (const accountId of accounts) await enqueueJob(ctx, syncJob, { accountId });
  if (unknownDeal && (await claimDealsPoll(ctx, new Date()))) await enqueueJob(ctx, dealsPollJob, {});
  for (const contactId of contacts) await publish(ctx, leadQualified, { connectionId, contactId });
  await ctx.tx.update(webhookReceipt).set({ processedAt: new Date() }).where(eq(webhookReceipt.id, receiptId));
  return { syncs: accounts.size, leads: contacts.size };
}
