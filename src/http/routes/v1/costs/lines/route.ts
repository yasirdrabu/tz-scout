import { addManualLine, listLines, type ManualLineInput } from '@/modules/analytics';
import type { CostCategory } from '@/modules/integrations/contracts/costs';
import { parseBody } from '../../_lib/body';
import { pageLimit } from '../../_lib/pagination';
import { created, v1Route } from '../../_lib/v1-route';
import { addLineBody } from './schemas';

/** Cost lines newest first, 50 a page. `?category=`, `?from=`, `?to=` (dates), `?include_voided=true`, `?cursor=`. */
export const GET = v1Route({ permission: 'costs:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const param = (k: string) => url.searchParams.get(k) || undefined;
  return listLines(ctx, {
    ...(param('category') ? { category: param('category') as CostCategory } : {}),
    ...(param('from') ? { from: param('from') } : {}),
    ...(param('to') ? { to: param('to') } : {}),
    ...(param('cursor') ? { cursor: param('cursor') } : {}),
    includeVoided: url.searchParams.get('include_voided') === 'true',
    limit: pageLimit(url),
  });
});

/** Adds a manual cost line (people only). */
export const POST = v1Route({ permission: 'costs:write', peopleOnly: true }, async (req, _principal, ctx) => {
  const body = await parseBody<Omit<ManualLineInput, 'note'> & { note?: string | null }>(req, addLineBody);
  return created(await addManualLine(ctx, { ...body, note: body.note ?? null }));
});
