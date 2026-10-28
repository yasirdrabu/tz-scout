import { z } from 'zod';
import { getReviewSettings, setAutoAcceptWorkingDays } from '@/modules/routing';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

// The service checks the range, so a person gets the plain-words message.
const body = z.strictObject({ auto_accept_working_days: z.number().nullable() });

export const GET = v1Route({ permission: 'settings:manage' }, async (_req, _principal, ctx) => getReviewSettings(ctx));

/** R1b changes only `auto_accept_working_days` (1 to 10, or null for off); statuses and reasons are R2. */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { autoAcceptWorkingDays } = await parseBody<{ autoAcceptWorkingDays: number | null }>(req, body);
  try {
    return await setAutoAcceptWorkingDays(ctx, autoAcceptWorkingDays);
  } catch (e) {
    if (e instanceof ScoutError && e.errors) {
      throw new ScoutError({ slug: e.slug, status: e.status, title: e.message, errors: e.errors.map((x) => ({ ...x, path: snake(x.path) })) });
    }
    throw e;
  }
});
