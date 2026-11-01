import { lastRescore } from '@/modules/scoring';
import { v1Route } from '../../_lib/v1-route';

/** The review queue's rescore banner: the last scoring settings change in the last 7 days, or `data: null` (Ruling 16). */
export const GET = v1Route({ permission: 'review:act' }, async (_req, _principal, ctx) => ({ data: await lastRescore(ctx) }));
