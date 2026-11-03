import { getWarmIntro } from '@/modules/intake';
import { explainScore } from '@/modules/scoring';
import { can } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

/**
 * SCO-E4-S2: the explanation with would_raise and a summary. A hidden, missing or unscored account is a 404, never a 403.
 * `warm_intro` is the account's live intro (it changes the moment someone confirms), not the stored score line.
 */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const offerId = new URL(req.url).searchParams.get('offer_id') || undefined;
  const explained = await explainScore(ctx, id, offerId ? { offerId } : {});
  if (!explained) throw notFound();
  const warm = await getWarmIntro(ctx, id);
  const canConfirm =
    !!warm &&
    !warm.confirmed &&
    principal.kind === 'user' &&
    (can(principal, 'review:act') || (warm.introducerUserId !== null && warm.introducerUserId === principal.id));
  return {
    ...explained,
    warmIntro: warm && {
      warmIntroId: warm.warmIntroId,
      introducerName: warm.introducerName,
      relationshipKey: warm.relationshipKey,
      relationshipLabel: warm.relationshipLabel,
      points: warm.points,
      fullPoints: warm.fullPoints,
      confirmed: warm.confirmed,
      canConfirm,
    },
  };
});
