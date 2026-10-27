import { getProfile, updateProfile, type ProfilePatch } from '@/modules/scoring';
import { parseBody } from '../../_lib/body';
import { accepted, v1Route } from '../../_lib/v1-route';
import { profilePatchBody } from './schema';

export const dynamic = 'force-dynamic';

export const GET = v1Route({ permission: 'scoring:manage' }, async (_req, _principal, ctx) => getProfile(ctx));

/** SCO-E5-S3: only the fields sent change. 202 because accounts are rescored in the background (Ruling 13). */
export const PUT = v1Route({ permission: 'scoring:manage' }, async (req, _principal, ctx) =>
  accepted(await updateProfile(ctx, await parseBody<ProfilePatch>(req, profilePatchBody))),
);
