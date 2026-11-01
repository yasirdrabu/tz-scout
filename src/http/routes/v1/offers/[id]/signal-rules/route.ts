import { z } from 'zod';
import { getOffer, listSignalRules, replaceSignalRules, type SignalRuleInput } from '@/modules/offers';
import { can } from '@/modules/tenancy';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

// Field limits are the service's to check, so a person gets the plain-words messages.
const body = z.strictObject({
  rules: z.array(
    z.strictObject({
      type: z.string(),
      label: z.string(),
      weight: z.number(),
      match: z.array(z.string()).default([]),
      min_value: z.number().nullable().default(null),
      why: z.string(),
      enabled: z.boolean().default(true),
    }),
  ),
});

// Like the offer itself, a draft is a 404 to people without `offers:manage`.
export const GET = v1Route({ permission: 'offers:read' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const offer = await getOffer(ctx, id);
  if (offer.status !== 'approved' && !can(principal, 'offers:manage')) throw notFound();
  return { data: await listSignalRules(ctx, id) };
});

// PUT /api/v1/offers/{id}/signal-rules replaces the rules with exactly these, in this order.
export const PUT = v1Route({ permission: 'scoring:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'offers');
  if (action) throw notFound();
  const { rules } = await parseBody<{ rules: (Omit<SignalRuleInput, 'minValue'> & { min_value: number | null })[] }>(req, body);
  const input = rules.map(({ min_value, ...r }) => ({ ...r, minValue: min_value }));
  return { data: await replaceSignalRules(ctx, id, input) };
});
