import { z } from 'zod';
import { KINDS, createRequest, type RequestInput } from '@/modules/enrichment';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { created, v1Route } from '../../../_lib/v1-route';

const body = z.strictObject({
  kind: z.enum(KINDS, { message: 'Pick what to find.' }),
  provider_key: z.string().min(1),
  roles: z.array(z.string()).optional(),
  person_ids: z.array(z.string()).optional(),
  reason: z.string().optional(),
});

/** Asks for enrichment: 201 with the new request, or 200 with `joined: true` when one was already open (Ruling 6). */
export const POST = v1Route({ permission: 'enrichment:request' }, async (req, principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const input = await parseBody<RequestInput>(req, body);
  const { request, joined } = await createRequest(ctx, principal, id, input);
  return joined ? { ...request, joined } : created({ ...request, joined });
});
