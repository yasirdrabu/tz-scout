import { z } from 'zod';
import { requestRescore } from '@/modules/scoring';
import { parseBody } from '../_lib/body';
import { accepted, v1Route } from '../_lib/v1-route';

const body = z.strictObject({ practice_id: z.string().optional(), source_id: z.string().optional() });

/** SCO-E5-S4: rescores the whole tenant, or one practice or source. Returns the job id and the run's id; GET /scoring/rescores/latest shows its progress. */
export const POST = v1Route({ permission: 'scoring:manage' }, async (req, _principal, ctx) => {
  const empty = (await req.clone().text()).trim() === '';
  const filter = empty ? {} : await parseBody<{ practiceId?: string; sourceId?: string }>(req, body);
  const { jobId, runId } = await requestRescore(ctx, filter);
  return accepted({ jobId, rescoreId: runId });
});
