import { z } from 'zod';
import { setTierOverride } from '@/modules/scoring';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

const body = z.strictObject({ tier: z.string().nullable(), note: z.string().nullish() });

/** Decision 4: set the tier by hand (kept across rescores), or null for Scout's tier. The note is optional (Open question 2). */
export const PUT = v1Route({ permission: 'review:act', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return setTierOverride(ctx, id, await parseBody<{ tier: string | null; note?: string | null }>(req, body));
});
