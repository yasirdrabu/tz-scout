import { allRuns, runsSummary } from '@/modules/ai-tasks';
import { listTenants } from '@/modules/tenancy';
import { runRow, runStatusParam } from '../../_lib/ai-runs';
import { decodeCursor, page, pageLimit } from '../../_lib/pagination';
import { adminRoute } from '../../_lib/v1-route';

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)$/;

/** The (created at as Postgres text, id) a cursor carries; a cursor without them is a 400. */
function afterParam(raw: string | null) {
  const c = decodeCursor(raw);
  if (!c) return undefined;
  if (typeof c.at !== 'string' || !TIMESTAMP.test(c.at) || typeof c.id !== 'string') decodeCursor('!');
  return { at: c.at as string, id: c.id as string };
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
  const { items, nextCursor } = page(rows, limit, (r) => ({ at: r.atText, id: r.id }));
  const names = new Map((await listTenants(tx)).map((t) => [t.id, t.name]));
  return {
    data: items.map((r) => ({ ...runRow(r), tenantName: names.get(r.tenantId) ?? null })),
    nextCursor,
    summary: await runsSummary(tx),
  };
});
