import { getProfile, updateProfile, type ProfilePatch } from '@/modules/scoring';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../_lib/body';
import { accepted, v1Route } from '../../_lib/v1-route';
import { profilePatchBody } from './schema';

export const dynamic = 'force-dynamic';

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export const GET = v1Route({ permission: 'scoring:manage' }, async (_req, _principal, ctx) => getProfile(ctx));

/** SCO-E5-S3: only the fields sent change. 202 because accounts are rescored in the background (Ruling 13). Error paths name the request's snake_case fields. */
export const PUT = v1Route({ permission: 'scoring:manage' }, async (req, _principal, ctx) => {
  const patch = await parseBody<ProfilePatch>(req, profilePatchBody);
  try {
    return accepted(await updateProfile(ctx, patch));
  } catch (e) {
    if (e instanceof ScoutError && e.errors) {
      throw new ScoutError({ slug: e.slug, status: e.status, title: e.message, errors: e.errors.map((x) => ({ ...x, path: snake(x.path) })) });
    }
    throw e;
  }
});
