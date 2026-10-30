// Who owns a company in HubSpot after we push it. Zach's rule (2026-10-16): assigning and pushing takes
// the account over, whoever had it, because old owners aren't working it. The one exception is a company
// someone is actually working: an open deal, or an existing customer. Pure and tested.

export type OwnershipInput = {
  existing: { ownerId: string | null; lifecycle: string | null; openDeals: number } | null;
  ownerId: string; // our rep's HubSpot owner id
  pushedOwnerId: string | null; // the owner we set on an earlier push
  currentOwnerActive: boolean | null; // null when we don't know the current owner
  takeOver: boolean; // the company setting (on by default)
  allowOtherOwner: boolean; // 'push anyway': add the context, keep their ownership
};

export type OwnershipDecision =
  | { action: 'assign'; replaceOwnerId: string | null; takenFrom: string | null } // set our rep as owner
  | { action: 'keep'; reason: string } // push the context, leave their owner
  | { action: 'stop'; reason: string }; // don't push; ask first

export function decideOwnership(i: OwnershipInput): OwnershipDecision {
  const e = i.existing;
  if (!e || !e.ownerId || e.ownerId === i.ownerId) return { action: 'assign', replaceOwnerId: e?.ownerId ?? null, takenFrom: null };
  if (i.pushedOwnerId && e.ownerId === i.pushedOwnerId) return { action: 'assign', replaceOwnerId: e.ownerId, takenFrom: null }; // we set it last time
  const engaged = e.openDeals > 0 ? 'has an open deal' : e.lifecycle === 'customer' ? 'is a customer' : null;
  if (i.allowOtherOwner) return { action: 'keep', reason: engaged ?? 'pushed with their ownership kept' };
  if (engaged) return { action: 'stop', reason: engaged };
  if (i.currentOwnerActive === false || i.takeOver) return { action: 'assign', replaceOwnerId: e.ownerId, takenFrom: e.ownerId };
  return { action: 'stop', reason: 'is owned by someone else' };
}
