import { tenantSummary } from '@/modules/tenancy';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

// Who the caller is: the tenant, the kind of credential, its scopes and data limit.
export const GET = v1Route({}, async (_req, principal, ctx) => ({
  tenant: await tenantSummary(ctx),
  kind: principal.kind,
  id: principal.id,
  scopes: principal.permissions,
  dataLimit: principal.dataLimit,
  sourceId: principal.sourceId ?? null,
  environment: principal.environment ?? null,
}));
