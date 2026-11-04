import { getSummaries } from '@/modules/accounts';
import { getOffer } from '@/modules/offers';
import { getTemplate, playbookFor } from '@/modules/playbooks';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/**
 * The playbook the assign dialog starts with: the playbook of the account's lead offer (the one picked, else Scout's best)
 * at the account's tier. `{ playbook: null, reason: 'none' }` when nothing is mapped, or the mapped playbook is archived.
 */
export const GET = v1Route({ permission: 'assign:act' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const [summary] = await getSummaries(ctx, [id]);
  if (!summary) throw notFound();
  const offerId = summary.leadOfferOverrideId ?? summary.bestOfferId;
  const none = { playbook: null, reason: 'none' };
  if (!offerId || !summary.tier) return none;
  const mapped = await playbookFor(ctx, offerId, summary.tier);
  if (!mapped || mapped.status === 'archived') return none;
  const [t, offer] = await Promise.all([getTemplate(ctx, mapped.templateId), getOffer(ctx, offerId)]);
  return {
    playbook: { id: t.id, name: t.name, steps: t.stepCount, days: t.days },
    reason: 'offer_tier',
    offer: { id: offer.id, name: offer.name },
    tier: summary.tier,
  };
});
