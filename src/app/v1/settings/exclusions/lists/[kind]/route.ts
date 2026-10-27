import { z } from 'zod';
import { listExclusionLists, setExclusionList } from '@/modules/accounts';
import { parseBody } from '../../../../_lib/body';
import { idAndAction, notFound } from '../../../../_lib/path';
import { v1Route } from '../../../../_lib/v1-route';

export const dynamic = 'force-dynamic';

const listBody = z.strictObject({ values: z.array(z.string()) });

/** Replaces the whole list of this kind. */
export const PUT = v1Route({ permission: 'settings:manage', peopleOnly: true }, async (req, _principal, ctx) => {
  const { id: kind, action } = idAndAction(req, 'lists');
  if (action) throw notFound();
  await setExclusionList(ctx, kind, (await parseBody<{ values: string[] }>(req, listBody)).values);
  return { kind, values: (await listExclusionLists(ctx))[kind] ?? [] };
});
