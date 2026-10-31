import { resetProfile } from '@/modules/scoring';
import { accepted, v1Route } from '../../../_lib/v1-route';

/** SCO-E5-S3-AC5: every setting back to the defaults. A static path, since `idAndAction` needs an id segment. */
export const POST = v1Route({ permission: 'scoring:manage' }, async (_req, _principal, ctx) => accepted(await resetProfile(ctx)));
