import { confirmWarmIntro } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { idAndAction, notFound } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';

/**
 * `POST /warm-intros/{id}:confirm` makes an agent- or vendor-declared intro count in full (SRC-E5-S2-AC2). A reviewer
 * or the intro's own introducer may confirm; a hidden account is a 404. Confirming twice changes nothing.
 */
export const POST = byAction('warm-intros', {
  confirm: v1Route({ permission: 'accounts:read', peopleOnly: true }, async (req, principal, ctx) => {
    const { id } = idAndAction(req, 'warm-intros');
    if (!id) throw notFound();
    return { warmIntro: await confirmWarmIntro(ctx, id, { canReview: can(principal, 'review:act') }) };
  }),
});
