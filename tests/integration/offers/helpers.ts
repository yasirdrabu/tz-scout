import { addMember } from '@/modules/tenancy';
import { freshTenant } from '../integrations/helpers';
import { inTenant, seedUser } from '../tenancy/helpers';

export { freshTenant };

/** An active member with the given role, as an actor for that tenant. */
export async function memberWith(tenantId: string, ownerActor: Parameters<typeof inTenant>[1], role: 'leader' | 'seller' | 'operator') {
  const u = await seedUser({ signedIn: true });
  await inTenant(tenantId, ownerActor, (ctx) => addMember(ctx, { email: u.email, role }));
  return u.actor;
}

export const completeOffer = {
  promise: 'Ship an AI platform in 90 days.',
  targetTitles: ['CTO'],
  industries: ['logistics'],
  typicalDealCents: 5_000_000,
  salesCycleDays: 60,
};
