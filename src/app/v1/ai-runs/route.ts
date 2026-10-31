import { listRuns, rawStatuses, runTotalsThisMonth, type AiMode } from '@/modules/ai-tasks';
import { ScoutError } from '@/platform/errors';
import { runRow, runStatusParam } from '../_lib/ai-runs';
import { parseIsoParam } from '../_lib/iso-date';
import { pageLimit } from '../_lib/pagination';
import { v1Route } from '../_lib/v1-route';

export const dynamic = 'force-dynamic';

const MODES: AiMode[] = ['live', 'rules', 'mock'];

function modeParam(raw: string | null): AiMode | undefined {
  if (!raw) return undefined;
  if ((MODES as string[]).includes(raw)) return raw as AiMode;
  throw new ScoutError({
    slug: 'validation',
    status: 400,
    title: 'Check the request.',
    errors: [{ path: 'mode', message: `Mode must be one of ${MODES.join(', ')}.` }],
  });
}

/**
 * This workspace's AI runs, newest first, for its owner (as the old Settings, AI page): `task`,
 * `status` (succeeded, failed, stopped_by_limit), `mode`, `from`, `to`, `limit` (up to 200). Runs,
 * tokens and cost per task this month are in `totals`.
 */
export const GET = v1Route({ permission: 'settings:manage' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const p = url.searchParams;
  const status = runStatusParam(p.get('status'));
  const runs = await listRuns(ctx, {
    task: p.get('task') || undefined,
    status: status ? rawStatuses(status) : undefined,
    mode: modeParam(p.get('mode')),
    from: parseIsoParam(p.get('from'), 'from'),
    to: parseIsoParam(p.get('to'), 'to'),
    limit: pageLimit(url),
  });
  return { data: runs.map(runRow), totals: await runTotalsThisMonth(ctx) };
});
