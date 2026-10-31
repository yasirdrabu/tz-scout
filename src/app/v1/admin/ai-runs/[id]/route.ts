import { anyRun } from '@/modules/ai-tasks';
import { listTenants } from '@/modules/tenancy';
import { runDetail } from '../../../_lib/ai-runs';
import { idAndAction, notFound } from '../../../_lib/path';
import { adminRoute } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** One run in any tenant, with the subject, fingerprint, what came back and the error. */
export const GET = adminRoute({}, async (req, _person, { tx }) => {
  const { id, action } = idAndAction(req, 'ai-runs');
  if (action) throw notFound();
  const run = await anyRun(tx, id);
  if (!run) throw notFound();
  const tenantName = (await listTenants(tx)).find((t) => t.id === run.tenantId)?.name ?? null;
  return { ...runDetail(run), tenantName };
});
