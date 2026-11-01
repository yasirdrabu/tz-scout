import { z } from 'zod';
import { setInsights } from '@/modules/routing';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

const body = z.strictObject({ insights: z.string() });

/** REV-E1-S3-AC1: leader insights on an account. Empty text clears them. */
export const PUT = v1Route({ permission: 'review:act', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  return setInsights(ctx, id, (await parseBody<{ insights: string }>(req, body)).insights);
});
