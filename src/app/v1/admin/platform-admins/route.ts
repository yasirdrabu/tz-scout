import { z } from 'zod';
import { addPlatformAdmin, platformAdmins } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { adminRoute, created } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** Platform admins who are not turned off. */
export const GET = adminRoute({}, async () => ({ data: await platformAdmins() }));

/** Makes an @taazaa.com address a platform admin (they sign in with Microsoft). */
export const POST = adminRoute({}, async (req, _person, { actor, correlationId }) => {
  const { email } = await parseBody<{ email: string }>(req, z.strictObject({ email: z.string().trim().min(1) }));
  return created(await addPlatformAdmin({ actor, correlationId }, email));
});
