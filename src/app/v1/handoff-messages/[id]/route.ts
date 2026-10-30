import { markCopied } from '@/modules/crm';
import { idAndAction } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** `POST /handoff-messages/{id}:copied`: the leader copied a seller's message. */
export const POST = byAction('handoff-messages', {
  copied: v1Route({ permission: 'crm:push', peopleOnly: true }, async (req, _principal, ctx) => markCopied(ctx, idAndAction(req, 'handoff-messages').id)),
});
