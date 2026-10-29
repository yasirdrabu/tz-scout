import { z } from 'zod';
import { getReviewSettings, setAutoAcceptWorkingDays } from '@/modules/routing';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

// The service checks the range, so a person gets the plain-words message.
const body = z.strictObject({ auto_accept_working_days: z.number().nullable() });

export const GET = v1Route({ permission: 'settings:manage' }, async (_req, _principal, ctx) => getReviewSettings(ctx));

/** R1b changes only `auto_accept_working_days` (1 to 10, or null for off); statuses and reasons are R2. */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) =>
  setAutoAcceptWorkingDays(ctx, (await parseBody<{ autoAcceptWorkingDays: number | null }>(req, body)).autoAcceptWorkingDays),
);
