import { filterVisibleAccountIds, getSummaries, resolveAccountId } from '@/modules/accounts';
import { getOffer } from '@/modules/offers';
import { getTemplate, playbookFor } from '@/modules/playbooks';
import { ScoutError } from '@/platform/errors';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/**
 * The playbook the assign dialog starts with: the playbook of the account's lead offer (the one picked, else Scout's best)
 * at the account's tier. `{ playbook: null, reason: 'none' }` when nothing is mapped, or the mapped playbook is not active.
 * An account outside the caller's data limit is a 404; a deleted lead offer counts as none.
 */
export const GET = v1Route({ permission: 'assign:act' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const found = await resolveAccountId(ctx, id);
  if (!found || (await filterVisibleAccountIds(ctx, [found.id])).length === 0) throw notFound();
  const [summary] = await getSummaries(ctx, [found.id]);
  if (!summary) throw notFound();
  const offerId = summary.leadOfferOverrideId ?? summary.bestOfferId;
  const none = { playbook: null, reason: 'none', offer: null, tier: summary.tier ?? null };
  if (!offerId || !summary.tier) return none;
  const mapped = await playbookFor(ctx, offerId, summary.tier);
  if (!mapped || mapped.status !== 'active') return none;
  const offer = await getOffer(ctx, offerId).catch((err: unknown) => {
    if (err instanceof ScoutError && err.status === 404) return null;
    throw err;
  });
  if (!offer) return none;
  const t = await getTemplate(ctx, mapped.templateId);
  return {
    playbook: { id: t.id, name: t.name, steps: t.stepCount, days: t.days },
    reason: 'offer_tier',
    offer: { id: offer.id, name: offer.name },
    tier: summary.tier,
  };
});
