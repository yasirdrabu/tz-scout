import { and, count, eq, isNotNull } from 'drizzle-orm';
import { resolveAccountId } from '@/modules/accounts';
import { listDeals, listOutcomeActivity } from '@/modules/crm';
import type { ModuleContext } from '@/platform/context';
import { accountPlan, outcome } from '../db/schema';
import { recordDealOutcomes } from './deal-outcomes';
import { recordOutcome } from './outcomes';

/**
 * Replays what the workspace already holds through `recordOutcome` (R3c-2 Ruling 11): CRM replies and meetings, cached
 * deals (by the one deal rule) and plans with `no_reply_at`. Refs match the live events, so a second run, or a live event
 * after it, records nothing twice. Returns how many outcomes were added. Background context only.
 */
export async function backfillOutcomes(ctx: ModuleContext): Promise<number> {
  const outcomes = async () => (await ctx.tx.select({ n: count() }).from(outcome).where(eq(outcome.tenantId, ctx.tenantId)))[0]!.n;
  const before = await outcomes();
  const survivor = async (id: string) => (await resolveAccountId(ctx, id))?.id ?? id;
  for (const a of await listOutcomeActivity(ctx)) {
    await recordOutcome(ctx, { accountId: await survivor(a.accountId), kind: a.kind, ref: `${a.system}:${a.externalId}`, source: 'crm', occurredAt: a.occurredAt });
  }
  // In open order, so a plan's one opportunity is its first deal.
  const deals = (await listDeals(ctx)).sort(
    (a, b) => (a.openedAt ?? a.syncedAt).getTime() - (b.openedAt ?? b.syncedAt).getTime() || (a.externalId < b.externalId ? -1 : a.externalId > b.externalId ? 1 : 0),
  );
  for (const d of deals) {
    await recordDealOutcomes(ctx, {
      accountId: await survivor(d.accountId),
      system: d.system,
      dealExternalId: d.externalId,
      status: d.status,
      amountCents: d.amountCents,
      openedAt: d.openedAt,
      closedAt: d.closedAt,
      observedAt: d.syncedAt,
    });
  }
  const unanswered = await ctx.tx
    .select({ id: accountPlan.id, accountId: accountPlan.accountId, noReplyAt: accountPlan.noReplyAt })
    .from(accountPlan)
    .where(and(eq(accountPlan.tenantId, ctx.tenantId), isNotNull(accountPlan.noReplyAt)))
    .orderBy(accountPlan.id);
  for (const p of unanswered) {
    await recordOutcome(ctx, { accountId: p.accountId, kind: 'no_response', ref: p.id, planId: p.id, source: 'playbooks', occurredAt: p.noReplyAt! });
  }
  return (await outcomes()) - before;
}
