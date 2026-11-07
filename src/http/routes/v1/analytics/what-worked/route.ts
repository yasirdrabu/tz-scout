import { whatWorkedView } from '@/modules/analytics';
import { v1Route } from '../../_lib/v1-route';

/** What worked on the playbook page (R3c-2): steps done and the results credited to them, following the caller's data limit. `?template_id=` narrows to one playbook. */
export const GET = v1Route({ permission: 'analytics:read' }, async (req, _principal, ctx) =>
  whatWorkedView(ctx, { templateId: new URL(req.url).searchParams.get('template_id') || undefined }),
);
