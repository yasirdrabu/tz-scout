import { and, eq, inArray } from 'drizzle-orm';
import type { ModuleContext } from '@/platform/context';
import { enqueueJob, publish } from '@/platform/events/outbox';
import { newId } from '@/platform/ids';
import { leadQualified } from '../contracts/events';
import { dealsPollJob, syncJob } from '../contracts/jobs';
import { deal, link, webhookReceipt } from '../db/schema';
import { parseHubSpotWebhook } from '../domain/webhook';
import { crmSystem } from './owners';
import { getCrmSettings } from './settings';

/**
 * An inbound HubSpot webhook that the route (Task 16) has already authenticated: it found `connectionId` for this
 * tenant's HubSpot connection and checked the v3 signature, so nothing here re-checks either.
 *
 * Stores the body, then:
 * - a deal or engagement event enqueues `crm.sync` once per affected account that has a company link. A deal is
 *   matched by its stored `crm.deal` row, else by a company id in the event. An engagement that matches no account is
 *   covered by the 15 minute activity poll; a deal Scout has never seen queues one `crm.deals.poll` instead.
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
  if (unknownDeal) await enqueueJob(ctx, dealsPollJob, {});
  for (const contactId of contacts) await publish(ctx, leadQualified, { connectionId, contactId });
  await ctx.tx.update(webhookReceipt).set({ processedAt: new Date() }).where(eq(webhookReceipt.id, receiptId));
  return { syncs: accounts.size, leads: contacts.size };
}
