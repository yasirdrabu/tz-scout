import { z } from 'zod';
import { KINDS, estimateFor, type RequestInput } from '@/modules/enrichment';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

const list = z
  .string()
  .optional()
  .transform((s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined));
const query = z.strictObject({
  kind: z.enum(KINDS, { message: 'Pick what to find.' }),
  provider_key: z.string({ message: 'Pick a provider.' }).min(1, 'Pick a provider.'),
  roles: list,
  person_ids: list,
});

/** The cost line the Enrich dialog shows: `{credits, cost_cents, currency, sample, text}`. */
export const GET = v1Route({ permission: 'enrichment:request' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const q = Object.fromEntries(new URL(req.url).searchParams);
  // parseBody reads JSON; the query string goes through the same schema check and error shape.
  const input = await parseBody<RequestInput>(new Request(req.url, { method: 'POST', body: JSON.stringify(q) }), query);
  return estimateFor(ctx, id, input);
});
