import { adminTenants, retryProvisioning, setTenantStatus } from '@/modules/tenancy';
import { idAndAction } from '../../../_lib/path';
import { adminByAction, adminRoute } from '../../../_lib/v1-route';

const setStatus = (status: 'active' | 'suspended') =>
  adminRoute({}, async (req, _person, ctx) => {
    const { id } = idAndAction(req, 'tenants');
    await setTenantStatus(ctx, id, status);
    return (await adminTenants(ctx.tx)).find((t) => t.id === id)!;
  });

// Sends a workspace whose provisioning failed through it again (D35); it answers before the job runs.
const retry = adminRoute({}, async (req, _person, ctx) => {
  const { id } = idAndAction(req, 'tenants');
  await retryProvisioning(ctx, id);
  return (await adminTenants(ctx.tx)).find((t) => t.id === id)!;
});

// POST /api/v1/admin/tenants/{id}:suspend, :resume and :retry-provisioning. A suspended tenant refuses sign-in, sessions and its API keys.
export const POST = adminByAction('tenants', {
  suspend: setStatus('suspended'),
  resume: setStatus('active'),
  'retry-provisioning': retry,
});
