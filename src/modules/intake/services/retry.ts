import { and, eq } from 'drizzle-orm';
import { audit } from '@/platform/audit';
import type { ModuleContext } from '@/platform/context';
import { ScoutError } from '@/platform/errors';
import { arrival, batch } from '../db/schema';
import { resumeStoppedImport, stoppedImportSource } from './imports';
import { settleBatch } from './resolve';
import { getBatch, notSuperseded } from './status';
import { senderOf, storeItems, type Channel } from './submit';
import { pageArrivals } from './visibility';

type ArrivalRow = typeof arrival.$inferSelect;

const nothing = () => new ScoutError({ slug: 'conflict', status: 409, title: 'Nothing in this batch can be retried.' });

/** The batch's rows rejected for the daily limit and not retried yet, that the caller may see, oldest first. */
async function capRejected(ctx: ModuleContext, batchId: string): Promise<ArrivalRow[]> {
  const rows: ArrivalRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await pageArrivals(ctx, {
      where: [eq(arrival.batchId, batchId), eq(arrival.status, 'rejected'), eq(arrival.rejectReason, 'daily_cap_reached'), notSuperseded],
      cursor,
      limit: 200,
    });
    rows.push(...page.data);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows.reverse();
}

/**
 * `POST /batches/{id}:retry` (Ruling 8): sends the rows the daily limit stopped again, through `storeItems`, as new
 * arrivals of the same batch from the same source, and marks each old row `superseded_by` its new one, so the batch
 * counts it once. An import that stopped because its source was paused is queued again from where it stopped. The
 * source's cap applies as on any send (`now` decides the tenant day). The batch row is locked, so two retries can't
 * both send. Returns how many rows were retried; 409 when there is nothing to retry.
 */
export async function retryBatch(ctx: ModuleContext, batchId: string, now = new Date()): Promise<number> {
  if (!(await getBatch(ctx, batchId))) throw new ScoutError({ slug: 'not-found', status: 404, title: 'That batch was not found.' });
  const [b] = await ctx.tx
    .select()
    .from(batch)
    .where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)))
    .for('update');
  const rows = await capRejected(ctx, batchId);
  const stoppedSource = await stoppedImportSource(ctx, batchId);
  if (rows.length === 0 && !stoppedSource) throw nothing();

  // Rows from one source and channel go together, in the order they first came.
  const groups = new Map<string, ArrivalRow[]>();
  for (const r of rows) {
    const key = `${r.closestSourceId}\u0000${r.channel}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  let open = 0;
  let stored = 0;
  let rejected = 0;
  for (const group of groups.values()) {
    const first = group[0]!;
    const sending: ModuleContext = { ...ctx, access: { ...(ctx.access ?? { dataLimit: { kind: 'own_source' } }), sourceId: first.closestSourceId } };
    const sender = await senderOf(sending);
    const result = await storeItems(
      sending,
      sender,
      batchId,
      group.map((r) => {
        const p = r.payload as { raw?: unknown; arrival?: unknown };
        return { raw: p.raw, ...(p.arrival !== undefined ? { body: p.arrival } : {}) };
      }),
      {
        channel: first.channel as Channel,
        canDeclareWarmIntro: first.canDeclareWarmIntro,
        ...(b!.vendorSourceId ? { vendorSourceId: b!.vendorSourceId } : {}),
        now,
      },
    );
    for (const [i, r] of group.entries()) {
      await ctx.tx
        .update(arrival)
        .set({ supersededBy: result.items[i]!.arrivalId })
        .where(and(eq(arrival.tenantId, ctx.tenantId), eq(arrival.id, r.id)));
    }
    open += result.items.filter((x) => x.status === 'received').length;
    stored += result.stored;
    rejected += result.rejected;
  }

  let resumed = 0;
  if (stoppedSource) {
    // Refused as any send is while the source is still paused or was archived.
    await senderOf({ ...ctx, access: { ...(ctx.access ?? { dataLimit: { kind: 'own_source' } }), sourceId: stoppedSource } });
    resumed = await resumeStoppedImport(ctx, batchId);
  }
  if (rows.length === 0 && resumed === 0) throw nothing();

  await ctx.tx
    .update(batch)
    .set({
      itemCount: b!.itemCount + stored - rows.length,
      ...(open > 0 || resumed > 0 ? { status: 'processing', completedAt: null } : {}),
    })
    .where(and(eq(batch.tenantId, ctx.tenantId), eq(batch.id, batchId)));
  await settleBatch(ctx, batchId, { rejected: rejected - rows.length });
  const retried = rows.length + resumed;
  await audit(ctx, { action: 'intake.batch.retried', subject: { type: 'batch', id: batchId }, after: { retried, rows: rows.length, resumed } });
  return retried;
}
