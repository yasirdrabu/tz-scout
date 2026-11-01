import { childSources, countBatches, listBatches, submitBatch } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { config } from '@/platform/config';
import { BATCH_MAX_BYTES, readJson } from '../_lib/intake';
import { pageLimit } from '../_lib/pagination';
import { accepted, v1Route } from '../_lib/v1-route';

export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  // `source_id`: the source's batches and those of the sources under it (the Source page's Batches tab).
  const sourceId = url.searchParams.get('source_id') || undefined;
  const sourceIds = sourceId ? [sourceId, ...(await childSources(ctx, [sourceId]))] : undefined;
  const page = await listBatches(ctx, { cursor: url.searchParams.get('cursor') || undefined, limit: pageLimit(url), sourceIds });
  // With `source_id`, `total` is the tab's count, from the API (C8).
  return sourceIds ? { ...page, total: await countBatches(ctx, sourceIds) } : page;
});

export const POST = v1Route({ permission: 'arrivals:write', maxBytes: BATCH_MAX_BYTES }, async (req, principal, ctx) => {
  const r = await submitBatch(ctx, await readJson(req), {
    channel: 'api',
    canDeclareWarmIntro: can(principal, 'warm_intro:declare'),
  });
  return accepted({
    batchId: r.batchId,
    statusUrl: new URL(`/api/v1/batches/${r.batchId}`, config.publicUrl).toString(),
    itemCount: r.items.length,
    items: r.items,
  });
});
