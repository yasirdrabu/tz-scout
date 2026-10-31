import { z } from 'zod';
import { listArrivals, submitArrival } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { config } from '@/platform/config';
import { ScoutError } from '@/platform/errors';
import { readJson } from '../_lib/intake';
import { pageLimit } from '../_lib/pagination';
import { accepted, v1Route } from '../_lib/v1-route';

const statusParam = z.enum(['received', 'resolving', 'resolved', 'rejected']);
const bad = (path: string, message: string) =>
  new ScoutError({ slug: 'validation', status: 400, title: 'Check the request.', errors: [{ path, message }] });

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const q = url.searchParams;
  const asked = q.get('status');
  const status = asked === null ? undefined : statusParam.safeParse(asked);
  if (status && !status.success) throw bad('status', 'Use received, resolving, resolved or rejected.');
  const sinceRaw = q.get('since');
  const since = sinceRaw === null ? undefined : new Date(sinceRaw);
  if (since && Number.isNaN(since.getTime())) throw bad('since', 'Use a date like 2026-10-01.');
  return listArrivals(ctx, {
    batchId: q.get('batch_id') ?? undefined,
    status: status?.data,
    since,
    cursor: q.get('cursor') || undefined,
    limit: pageLimit(url),
  });
});

export const POST = v1Route({ permission: 'arrivals:write' }, async (req, principal, ctx) => {
  const r = await submitArrival(ctx, await readJson(req), {
    channel: 'api',
    canDeclareWarmIntro: can(principal, 'warm_intro:declare'),
  });
  const body = { arrivalId: r.arrivalId, statusUrl: new URL(`/v1/arrivals/${r.arrivalId}`, config.publicUrl).toString() };
  return r.duplicateOfRequest ? { ...body, duplicateOfRequest: true } : accepted(body);
});
