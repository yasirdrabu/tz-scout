import { z } from 'zod';
import { setLastWorkspace } from '@/modules/tenancy';
import { parseBody } from '../../_lib/body';
import { noContent, sessionRoute } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const Body = z.object({ slug: z.string().trim().min(1, 'Send the workspace slug.') }).strict();

/** Switches workspace: the slug becomes the person's last used one, where sign-in and `/me` land next. */
export const PUT = sessionRoute({}, async (req, person) => {
  const { slug } = await parseBody<{ slug: string }>(req, Body);
  await setLastWorkspace(person.userId, person.platformAdmin, slug);
  return noContent();
});
