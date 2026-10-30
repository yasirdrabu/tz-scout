import { getHandoffs } from '@/modules/crm';
import { idAndAction } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** The account's handoffs and their follow-through. The service answers 404 for an account outside the data limit. */
export const GET = v1Route({ permission: 'accounts:read' }, async (req, _principal, ctx) => getHandoffs(ctx, idAndAction(req, 'accounts').id));
