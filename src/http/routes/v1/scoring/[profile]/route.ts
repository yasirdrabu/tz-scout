import { previewProfile, type ProfilePatch } from '@/modules/scoring';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';
import { previewBody } from '../profile/schema';

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * `POST /api/v1/scoring/profile:preview` (SCO-E6-S4-AC3): what draft weights and cutoffs would do to the accounts
 * scored in the last 90 days. Writes nothing. The action rides on the segment after `scoring`, the way `{id}:action` does.
 */
export const POST = v1Route({ permission: 'scoring:manage' }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'scoring');
  if (id !== 'profile' || action !== 'preview') throw notFound();
  const draft = await parseBody<ProfilePatch>(req, previewBody);
  try {
    return await previewProfile(ctx, draft);
  } catch (e) {
    if (e instanceof ScoutError && e.errors) {
      throw new ScoutError({ slug: e.slug, status: e.status, title: e.message, errors: e.errors.map((x) => ({ ...x, path: snake(x.path) })) });
    }
    throw e;
  }
});
