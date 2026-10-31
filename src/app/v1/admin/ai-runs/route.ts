import { allRuns, runsSummary } from '@/modules/ai-tasks';
import { listTenants } from '@/modules/tenancy';
import { runRow, runStatusParam } from '../../_lib/ai-runs';
import { decodeCursor, page, pageLimit } from '../../_lib/pagination';
import { adminRoute } from '../../_lib/v1-route';

export const dynamic = 'force-dynamic';

/** The (created at, id) a cursor carries; a cursor without them is a 400. */
function afterParam(raw: string | null) {
  const c = decodeCursor(raw);
  if (!c) return undefined;
  const createdAt = typeof c.at === 'string' ? new Date(c.at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime()) || typeof c.id !== 'string') decodeCursor('!');
  return { createdAt: createdAt!, id: c.id as string };
}

/**
 * Every tenant's AI runs, newest first (Decision 24): `q` (run id, task or account id), `status`
 * (succeeded, failed, stopped_by_limit), `task`, `tenant` (tenant id), `cursor`, `limit`. The
 * tiles for today (UTC) are in `summary`.
 */
export const GET = adminRoute({}, async (req, _person, { tx }) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  const limit = pageLimit(url);
  const rows = await allRuns(tx, {
    q: p.get('q') || undefined,
    status: runStatusParam(p.get('status')),
    task: p.get('task') || undefined,
    tenantId: p.get('tenant') || undefined,
    after: afterParam(p.get('cursor')),
    limit: limit + 1,
  });
  const { items, nextCursor } = page(rows, limit, (r) => ({ at: r.createdAt.toISOString(), id: r.id }));
  const names = new Map((await listTenants()).map((t) => [t.id, t.name]));
  return {
    data: items.map((r) => ({ ...runRow(r), tenantName: names.get(r.tenantId) ?? null })),
    nextCursor,
    summary: await runsSummary(tx),
  };
});
