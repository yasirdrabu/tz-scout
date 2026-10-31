import { z } from 'zod';
import { setPractices } from '@/modules/accounts';
import { listPractices } from '@/modules/offers';
import { ScoutError } from '@/platform/errors';
import { parseBody } from '../../../_lib/body';
import { idAndAction, notFound } from '../../../_lib/path';
import { v1Route } from '../../../_lib/v1-route';

const practicesBody = z.strictObject({ practice_ids: z.array(z.string()) });

/** Replaces the account's practices. A person's list wins, so a practice can be removed as well as added. */
export const PUT = v1Route({ permission: 'accounts:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id, action } = idAndAction(req, 'accounts');
  if (action) throw notFound();
  const { practiceIds } = await parseBody<{ practiceIds: string[] }>(req, practicesBody);
  const active = new Set((await listPractices(ctx)).map((p) => p.id));
  if (practiceIds.some((pid) => !active.has(pid))) {
    throw new ScoutError({
      slug: 'validation',
      status: 400,
      title: 'Pick practices from your practice list.',
      errors: [{ path: 'practice_ids', message: 'Pick practices from your practice list.' }],
    });
  }
  return { practiceIds: await setPractices(ctx, id, practiceIds, 'person') };
});
