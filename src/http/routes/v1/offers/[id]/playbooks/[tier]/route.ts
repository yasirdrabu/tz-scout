import { z } from 'zod';
import { getOffer } from '@/modules/offers';
import { setOfferPlaybook } from '@/modules/playbooks';
import { parseBody } from '../../../../_lib/body';
import { idAndAction, notFound } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

const body = z.strictObject({ playbook_id: z.string().nullable() });

// PUT /api/v1/offers/{id}/playbooks/{tier} with {playbook_id | null} sets or clears the mapping; returns all three tiers.
export const PUT = v1Route({ permission: 'offers:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const parts = new URL(req.url).pathname.split('/').filter(Boolean);
  const tier = decodeURIComponent(parts[parts.indexOf('playbooks') + 1] ?? '');
  const { playbookId } = await parseBody<{ playbookId: string | null }>(req, body);
  await getOffer(ctx, id);
  return { data: await setOfferPlaybook(ctx, id, tier, playbookId) };
});
