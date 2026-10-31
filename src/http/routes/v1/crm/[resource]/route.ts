import { z } from 'zod';
import { confirmOwnerMatch, listOwners, ownerMatches, setUpHubSpotFields, syncOwners } from '@/modules/crm';
import { simulateQualifiedLead } from '@/modules/intake';
import { parseBody } from '../../_lib/body';
import { idAndAction, notFound } from '../../_lib/path';
import { v1Route } from '../../_lib/v1-route';

const confirmBody = z.strictObject({ user_id: z.string().min(1), external_owner_id: z.string().min(1) });

type Handler = (req: Request) => Promise<Response>;
const unknown = v1Route({}, async () => {
  throw notFound();
});

/**
 * The segment after /crm is `<resource>` or `<resource>:<action>` (`owners:sync`), so one dynamic route serves them all.
 * Each entry is its own v1Route and so has its own permission; anything else is a 404 after sign-in.
 */
const dispatch =
  (routes: Record<string, Handler>): Handler =>
  (req) => {
    let key: string | null = null;
    try {
      const { id, action } = idAndAction(req, 'crm');
      key = action ? `${id}:${action}` : id;
    } catch {
      // A malformed path is handled by the 404 route.
    }
    return (key && Object.hasOwn(routes, key) ? routes[key]! : unknown)(req);
  };

export const GET = dispatch({
  owners: v1Route({ permission: 'members:manage', peopleOnly: true }, async (_req, _principal, ctx) => ({ data: await listOwners(ctx) })),
  'owner-matches': v1Route({ permission: 'members:manage', peopleOnly: true }, async (_req, _principal, ctx) => ({ data: await ownerMatches(ctx) })),
});

export const POST = dispatch({
  'owners:sync': v1Route({ permission: 'members:manage', peopleOnly: true }, async (_req, _principal, ctx) => syncOwners(ctx)),
  'owner-matches:confirm': v1Route({ permission: 'members:manage', peopleOnly: true }, async (req, _principal, ctx) => {
    await confirmOwnerMatch(ctx, await parseBody<{ userId: string; externalOwnerId: string }>(req, confirmBody));
    return { data: await ownerMatches(ctx) };
  }),
  'fields:set-up': v1Route({ permission: 'integrations:manage', peopleOnly: true }, async (_req, _principal, ctx) => setUpHubSpotFields(ctx)),
  'qualified-leads:simulate': v1Route({ permission: 'integrations:manage', peopleOnly: true }, async (_req, _principal, ctx) => simulateQualifiedLead(ctx)),
});
