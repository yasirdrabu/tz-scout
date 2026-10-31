import { testEventRoundTrip } from '@/platform/diagnostics';
import { ScoutError } from '@/platform/errors';
import { adminRoute } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/**
 * Sends a ping through the outbox, relay, NATS and worker and waits up to 10 seconds for the answer.
 * 504 `no-answer` when nothing answered. Never replayed: each call measures a new round trip.
 */
export const POST = adminRoute({ idempotent: false }, async (_req, _person, ctx) => {
  const ms = await testEventRoundTrip(ctx);
  if (ms === null) {
    throw new ScoutError({ slug: 'no-answer', status: 504, title: 'No answer after 10 seconds. Check the worker and relay.' });
  }
  return { roundTripMs: ms };
});
