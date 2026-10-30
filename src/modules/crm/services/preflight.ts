import { and, desc, eq } from 'drizzle-orm';
import { crmOwnerId, members } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { crmSetting, handoff } from '../db/schema';
import { decideOwnership } from '../domain/ownership';
import { refreshCheck, type CompanyCheck } from './checks';
import { crmSystem, isOwnerActive } from './owners';

export type OwnershipPreflightDetail = {
  result: 'new' | 'assign' | 'stop' | 'blocked';
  message: string;
  reason: 'open_deal' | 'customer' | 'owned_elsewhere' | 'no_owner' | null;
  currentOwnerName: string | null;
  takenFrom: string | null;
};

const blocked = (message: string, reason: OwnershipPreflightDetail['reason']): OwnershipPreflightDetail => ({ result: 'blocked', message, reason, currentOwnerName: null, takenFrom: null });

/** The owner Scout set on the account's latest completed `assign` handoff, or null. */
async function pushedOwnerId(ctx: ModuleContext, accountId: string): Promise<string | null> {
  const [row] = await ctx.tx
    .select({ owner: handoff.ownerExternalId })
    .from(handoff)
    .where(and(eq(handoff.tenantId, ctx.tenantId), eq(handoff.accountId, accountId), eq(handoff.status, 'completed'), eq(handoff.ownershipAction, 'assign')))
    .orderBy(desc(handoff.completedAt), desc(handoff.queuedAt))
    .limit(1);
  return row?.owner ?? null;
}

/** Why the rule stopped: an open deal first, then a customer, else someone else owns it. */
export const stopReason = (check: Pick<CompanyCheck, 'openDeals' | 'lifecycle'>): 'open_deal' | 'customer' | 'owned_elsewhere' =>
  check.openDeals > 0 ? 'open_deal' : check.lifecycle === 'customer' ? 'customer' : 'owned_elsewhere';

/**
 * Asks the CRM about the account's company now (refreshing its stored check) and applies the ownership rule
 * for this seller's owner id. Used by the preflight and again by the push (CRM-E3-S1-AC5).
 */
export async function recheckOwnership(ctx: ModuleContext, accountId: string, sellerOwner: string, allowOtherOwner: boolean) {
  const system = await crmSystem(ctx);
  const check = await refreshCheck(ctx, accountId);
  const [setting] = await ctx.tx.select({ takeOver: crmSetting.takeOverStaleOwnership }).from(crmSetting).where(eq(crmSetting.tenantId, ctx.tenantId));
  const currentActive = check?.ownerExternalId ? await isOwnerActive(ctx, system, check.ownerExternalId) : null;
  const decision = decideOwnership({
    existing: check?.exists ? { ownerId: check.ownerExternalId, lifecycle: check.lifecycle, openDeals: check.openDeals } : null,
    ownerId: sellerOwner,
    pushedOwnerId: await pushedOwnerId(ctx, accountId),
    currentOwnerActive: currentActive,
    takeOver: setting?.takeOver ?? true,
    allowOtherOwner,
  });
  const currentOwnerName = check?.ownerName ?? (check?.ownerExternalId ? `HubSpot owner ${check.ownerExternalId}` : null);
  return { check, decision, currentActive, currentOwnerName };
}

/**
 * What assigning this account to this seller would do in the CRM (Ruling 1). Asks the CRM now (which refreshes
 * the account's stored check), applies the ownership rule and words the answer.
 */
export async function preflightOwnership(ctx: ModuleContext, accountId: string, sellerUserId: string): Promise<OwnershipPreflightDetail> {
  const system = await crmSystem(ctx);
  const seller = (await members(ctx)).find((m) => m.userId === sellerUserId);
  const first = seller?.name.trim().split(/\s+/)[0] || 'This person';
  const sellerOwner = await crmOwnerId(ctx, sellerUserId, system);
  if (!sellerOwner) return blocked(`${first} has no HubSpot owner set. Set it in Members first.`, 'no_owner');
  if ((await isOwnerActive(ctx, system, sellerOwner)) === false) return blocked('Link this person to a HubSpot owner first', 'no_owner');

  const { check, decision, currentActive, currentOwnerName: name } = await recheckOwnership(ctx, accountId, sellerOwner, false);
  if (!check?.exists) return { result: 'new', message: 'New in the CRM', reason: null, currentOwnerName: null, takenFrom: null };

  const out = (result: 'assign' | 'stop', message: string, reason: OwnershipPreflightDetail['reason'], takenFrom: string | null = null): OwnershipPreflightDetail => ({
    result,
    message,
    reason,
    currentOwnerName: name,
    takenFrom,
  });

  if (decision.action === 'stop') {
    const reason = stopReason(check);
    const what = { open_deal: 'Open deal owned by', customer: 'Customer owned by', owned_elsewhere: 'Owned by' }[reason];
    return out('stop', `${what} ${name}: will not change owner`, reason);
  }
  if (decision.action === 'keep') return out('stop', `Owned by ${name}: will not change owner`, 'owned_elsewhere'); // allowOtherOwner is false here
  if (!check.ownerExternalId) return out('assign', `In the CRM with no owner: will move to ${first}`, null);
  if (check.ownerExternalId === sellerOwner) return out('assign', `Already owned by ${first}`, null);
  return out('assign', currentActive === false ? `Owned by ${name} (inactive): will move to ${first}` : `Owned by ${name}: will move to ${first}`, null, decision.takenFrom);
}

/** The port Routing calls before an assignment; CRM implements it and the composition root registers it. */
// Typed structurally: CRM does not import Routing, and compose.ts checks the shape against Routing's port.
export const crmOwnershipPreflight = {
  check: async (ctx: ModuleContext, accountId: string, sellerUserId: string): Promise<Pick<OwnershipPreflightDetail, 'result' | 'message'>> => {
    const { result, message } = await preflightOwnership(ctx, accountId, sellerUserId);
    return { result, message };
  },
};
