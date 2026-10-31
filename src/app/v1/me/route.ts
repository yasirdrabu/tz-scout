import { personSummary, tenantSummary, workspacesFor } from '@/modules/tenancy';
import { sessionRoute, v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

const userOf = (p: { id: string; name: string; email: string; platformAdmin: boolean }) => ({
  id: p.id,
  name: p.name,
  email: p.email,
  platformAdmin: p.platformAdmin,
});

// Who the caller is: the person, the tenant, their workspaces, the kind of credential, its scopes and data limit.
const inTenant = v1Route({}, async (_req, principal, ctx) => {
  const person = principal.kind === 'user' && principal.userId ? await personSummary(principal.userId) : null;
  return {
    user: person ? userOf(person) : null,
    tenant: await tenantSummary(ctx),
    workspaces: person ? await workspacesFor(person.id, person.platformAdmin) : [],
    kind: principal.kind,
    id: principal.id,
    scopes: principal.permissions,
    dataLimit: principal.dataLimit,
    sourceId: principal.sourceId ?? null,
    environment: principal.environment ?? null,
  };
});

// A signed-in person with no workspace to land in (a platform admin with no membership, say).
const noTenant = sessionRoute({}, async (_req, person) => ({
  user: userOf({ ...person, id: person.userId }),
  tenant: null,
  workspaces: await workspacesFor(person.userId, person.platformAdmin),
  kind: 'user',
  id: person.userId,
  scopes: [],
  dataLimit: null,
  sourceId: null,
  environment: null,
}));

/**
 * The tenant is the `x-scout-tenant` one, else the person's last used. With neither header nor a
 * workspace to land in, a signed-in person gets `tenant: null`.
 */
export async function GET(req: Request): Promise<Response> {
  const res = await inTenant(req);
  if (res.status !== 401 || req.headers.has('authorization') || req.headers.get('x-scout-tenant')) return res;
  return noTenant(req);
}
