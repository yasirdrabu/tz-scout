import { z } from 'zod';
import { getReviewSettings, saveReviewSettings } from '@/modules/routing';
import { parseBody } from '../../_lib/body';
import { v1Route } from '../../_lib/v1-route';
import { reasonItem, statusItem, toReasonEdits, toStatusEdits } from './edits';

// The service checks the lists and the range, so a person gets the plain-words messages at their paths.
const body = z.strictObject({
  statuses: z.array(statusItem).optional(),
  reasons: z.array(reasonItem).optional(),
  auto_accept_working_days: z.number().nullable().optional(),
});
type Body = { statuses?: z.infer<typeof statusItem>[]; reasons?: z.infer<typeof reasonItem>[]; autoAcceptWorkingDays?: number | null };

export const GET = v1Route({ permission: 'settings:manage' }, async (_req, _principal, ctx) => getReviewSettings(ctx));

/**
 * Ruling 19: the editor's one save. Statuses, reasons and `auto_accept_working_days` (1 to 10, or null
 * for off), any of them, in one transaction; a bad part saves nothing. Returns the settings with counts.
 */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const b = await parseBody<Body>(req, body);
  return saveReviewSettings(ctx, {
    ...(b.statuses ? { statuses: toStatusEdits(b.statuses) } : {}),
    ...(b.reasons ? { reasons: toReasonEdits(b.reasons) } : {}),
    ...(b.autoAcceptWorkingDays !== undefined ? { autoAcceptWorkingDays: b.autoAcceptWorkingDays } : {}),
  });
});
