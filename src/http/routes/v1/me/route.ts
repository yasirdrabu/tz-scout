import { describeAccess, memberRole, personSummary, signInFacts, tenantSummary, workspacesFor, type SignInMethod } from '@/modules/tenancy';
import type { Tx } from '@/platform/db/tenant';
import { sessionRoute, v1Route } from '../_lib/v1-route';

const userOf = (p: { id: string; name: string; email: string; platformAdmin: boolean }, signInMethod: SignInMethod) => ({
  id: p.id,
  name: p.name,
  email: p.email,
  platformAdmin: p.platformAdmin,
  signInMethod,
});

const methodOf = async (tx: Tx, userId: string) => (await signInFacts(tx, [userId])).get(userId)?.signInMethod ?? null;

/**
 * Who the caller is: the person (with how they sign in), the tenant, their workspaces, their role
 * here (null for a key or a platform admin who is not a member), the kind of credential, its scopes
 * and data limit, and the data limit in plain words (`access_summary`).
 */
const inTenant = v1Route({}, async (_req, principal, ctx) => {
  const person = principal.kind === 'user' && principal.userId ? await personSummary(principal.userId) : null;
  return {
    user: person ? userOf(person, await methodOf(ctx.tx, person.id)) : null,
    tenant: await tenantSummary(ctx),
    workspaces: person ? await workspacesFor(person.id, person.platformAdmin) : [],
    kind: principal.kind,
    id: principal.id,
    role: person ? await memberRole(ctx, person.id) : null,
    scopes: principal.permissions,
    dataLimit: principal.dataLimit,
    accessSummary: describeAccess(principal),
    sourceId: principal.sourceId ?? null,
    environment: principal.environment ?? null,
  };
});

// A signed-in person with no workspace to land in (a platform admin with no membership, say).
const noTenant = sessionRoute({}, async (_req, person, { tx }) => ({
  user: userOf({ ...person, id: person.userId }, await methodOf(tx, person.userId)),
  tenant: null,
  workspaces: await workspacesFor(person.userId, person.platformAdmin),
  kind: 'user',
  id: person.userId,
  role: null,
  scopes: [],
  dataLimit: null,
  accessSummary: [],
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
