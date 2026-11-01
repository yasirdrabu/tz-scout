import { BATCH_STATUS_KEYS, childSources, listBatchRows, submitBatch, type BatchStatusKey } from '@/modules/intake';
import { can } from '@/modules/tenancy';
import { config } from '@/platform/config';
import { ScoutError } from '@/platform/errors';
import { BATCH_MAX_BYTES, readJson } from '../_lib/intake';
import { pageLimit } from '../_lib/pagination';
import { accepted, v1Route } from '../_lib/v1-route';

const invalid = (path: string, title: string) => new ScoutError({ slug: 'validation', status: 400, title, errors: [{ path, message: title }] });

/** `status_key` repeats or is comma separated. */
function statusKeys(url: URL): BatchStatusKey[] | undefined {
  const keys = url.searchParams.getAll('status_key').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  for (const k of keys) if (!(BATCH_STATUS_KEYS as string[]).includes(k)) throw invalid('status_key', 'Pick a status from the list.');
  return keys.length ? (keys as BatchStatusKey[]) : undefined;
}

function since(url: URL): Date | undefined {
  const v = url.searchParams.get('since');
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw invalid('since', 'Use a date like 2026-10-24.');
  return d;
}

/**
 * Batches newest first (§13) with the derived status, issue and progress (Ruling 8). Filters: `status_key`, `source_id`
 * (the source's batches and those of the sources under it, on any chain column), `sent_by` (a member's user id, or a
 * key id), `since` and `q` (name, notes and file names). `total` and `meta.counts_by_status` come from the API (C8).
 */
export const GET = v1Route({ permission: 'arrivals:read' }, async (req, _principal, ctx) => {
  const url = new URL(req.url);
  const sourceId = url.searchParams.get('source_id') || undefined;
  const sentBy = url.searchParams.get('sent_by') || undefined;
  return listBatchRows(ctx, {
    cursor: url.searchParams.get('cursor') || undefined,
    limit: pageLimit(url),
    statusKeys: statusKeys(url),
    sourceIds: sourceId ? [sourceId, ...(await childSources(ctx, [sourceId]))] : undefined,
    principal: sentBy ? `${sentBy.startsWith('key_') ? 'agent' : 'user'}:${sentBy}` : undefined,
    since: since(url),
    q: url.searchParams.get('q')?.trim() || undefined,
  });
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
