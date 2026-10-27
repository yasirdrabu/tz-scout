import { z } from 'zod';
import { archiveSignal } from '@/modules/accounts';
import { parseBody } from '../../_lib/body';
import { idAndAction } from '../../_lib/path';
import { byAction, v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const archiveBody = z.strictObject({ reason: z.string().optional() });

/** `POST /signals/{id}:archive`, "Not relevant". The reason goes in the audit log. */
export const POST = byAction('signals', {
  archive: v1Route({ permission: 'accounts:write', peopleOnly: true }, async (req, _principal, ctx) => {
    const { id } = idAndAction(req, 'signals');
    const { reason } = await parseBody<{ reason?: string }>(req, archiveBody);
    await archiveSignal(ctx, id, reason ?? '');
    return { id, archived: true };
  }),
});
