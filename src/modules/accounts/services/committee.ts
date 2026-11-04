import { and, eq } from 'drizzle-orm';
import { getOffer } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { accountSummary, buyingRole } from '../db/schema';
import { coverage, type CommitteeRole, type CommitteeSummary } from '../domain/committee';
import { resolveAccountId } from './match';
import { listPeople } from './read';
import { filterVisibleAccountIds } from './visibility';

export type Committee = {
  offer: { id: string; name: string } | null;
  roles: CommitteeRole[];
  summary: CommitteeSummary;
  gaps: string[];
  /** True when the required roles are the core three: no offer, or the offer has no active required roles. */
  coreRoles: boolean;
};

const notFound = (what: string) => new ScoutError({ slug: 'not-found', status: 404, title: `That ${what} was not found.` });

/** The offer for the committee, or null when none is set or the lead no longer resolves. An explicit unknown offer is a 404. */
async function offerFor(ctx: ModuleContext, accountId: string, offerId?: string) {
  let id = offerId;
  if (!id) {
    const [s] = await ctx.tx
      .select({ lead: accountSummary.leadOfferOverrideId, best: accountSummary.bestOfferId })
      .from(accountSummary)
      .where(and(eq(accountSummary.tenantId, ctx.tenantId), eq(accountSummary.accountId, accountId)));
    id = s?.lead ?? s?.best ?? undefined;
  }
  if (!id) return null;
  try {
    return await getOffer(ctx, id);
  } catch (e) {
    if (e instanceof ScoutError && e.status === 404 && !offerId) return null;
    throw e;
  }
}

/** Who covers which buying roles for an offer (the given one, else the lead offer, else the core three). 404 for a hidden account. */
export async function getCommittee(ctx: ModuleContext, accountId: string, offerId?: string): Promise<Committee> {
  const found = await resolveAccountId(ctx, accountId);
  if (!found || (await filterVisibleAccountIds(ctx, [found.id])).length === 0) throw notFound('account');
  const offer = await offerFor(ctx, found.id, offerId);
  const roles = await ctx.tx.select().from(buyingRole).where(eq(buyingRole.tenantId, ctx.tenantId));
  const people = await listPeople(ctx, found.id);
  const result = coverage(
    roles,
    people.map((p) => ({
      id: p.id,
      name: [p.firstName, p.lastName].filter(Boolean).join(' ') || 'Someone',
      title: p.title,
      roles: p.roles.map((r) => ({ key: r.key, origin: r.origin })),
    })),
    offer ? { requiredRoles: offer.targetBuyingRoles, optionalRoles: offer.optionalBuyingRoles } : null,
  );
  return { offer: offer ? { id: offer.id, name: offer.name } : null, ...result };
}
