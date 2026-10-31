import { adminTenants, setTenantStatus } from '@/modules/tenancy';
import { idAndAction } from '../../../_lib/path';
import { adminByAction, adminRoute } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const setStatus = (status: 'active' | 'suspended') =>
  adminRoute({}, async (req, _person, { actor, correlationId }) => {
    const { id } = idAndAction(req, 'tenants');
    await setTenantStatus({ actor, correlationId }, id, status);
    return (await adminTenants()).find((t) => t.id === id)!;
  });

// POST /v1/admin/tenants/{id}:suspend and :resume. A suspended tenant refuses sign-in, sessions and its API keys.
export const POST = adminByAction('tenants', {
  suspend: setStatus('suspended'),
  resume: setStatus('active'),
});
