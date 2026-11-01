import { and, eq, isNull } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { getBatch, retryBatch, submitBatch, updateSource } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, validArrival, type Tenant } from './helpers';

let t: Tenant;

beforeAll(async () => {
  t = await freshTenant();
});

async function cappedBatch(): Promise<{ agentId: string; batchId: string }> {
  const { agentId } = await personAndAgent(t);
  await t.run((ctx) => updateSource(ctx, agentId, { dailyArrivalCap: 1 }));
  const { batchId } = await asSource(t, agentId, (ctx) =>
    submitBatch(ctx, { name: 'Capped', items: [validArrival(), validArrival(), validArrival()] }, { channel: 'api' }),
  );
  await runOutbox(t.tenantId);
  return { agentId, batchId };
}

const rowsOf = (batchId: string) => t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.batchId, batchId)));

describe('retryBatch (Ruling 8)', () => {
  it('sends the rows the daily limit stopped on the next tenant day, under that day\'s limit', async () => {
    const { batchId } = await cappedBatch();
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await t.run((ctx) => retryBatch(ctx, batchId, tomorrow))).toBe(2);
    await runOutbox(t.tenantId);

    const rows = await rowsOf(batchId);
    const superseded = rows.filter((r) => r.supersededBy);
    expect(superseded).toHaveLength(2);
    // The cap is 1 a day, so tomorrow takes one; the other is held by the limit again and can be retried again.
    const replacements = superseded.map((old) => rows.find((r) => r.id === old.supersededBy)!);
    expect(replacements.map((r) => r.status).sort()).toEqual(['rejected', 'resolved']);
    expect(replacements.find((r) => r.status === 'rejected')!.rejectReason).toBe('daily_cap_reached');
    const detail = (await t.run((ctx) => getBatch(ctx, batchId)))!;
    expect(detail).toMatchObject({ itemCount: 3, status: 'completed', stages: { resolved: 2, rejected: 1 } });
  });

  it('sends them all when the next day has room', async () => {
    const { agentId, batchId } = await cappedBatch();
    await t.run((ctx) => updateSource(ctx, agentId, { dailyArrivalCap: 2 }));
    expect(await t.run((ctx) => retryBatch(ctx, batchId, new Date(Date.now() + 86_400_000)))).toBe(2);
    await runOutbox(t.tenantId);
    const detail = (await t.run((ctx) => getBatch(ctx, batchId)))!;
    expect(detail).toMatchObject({ itemCount: 3, status: 'completed', stages: { resolved: 3, rejected: 0 }, rejections: [] });
  });

  it('rejects them again while the limit still holds, and they stay retryable', async () => {
    const { batchId } = await cappedBatch();
    expect(await t.run((ctx) => retryBatch(ctx, batchId))).toBe(2);
    const live = await t.run((ctx) =>
      ctx.tx
        .select()
        .from(arrival)
        .where(and(eq(arrival.batchId, batchId), eq(arrival.rejectReason, 'daily_cap_reached'), isNull(arrival.supersededBy))),
    );
    expect(live).toHaveLength(2);
    expect((await t.run((ctx) => getBatch(ctx, batchId)))!.stages.rejected).toBe(2);
  });

  it('is a 409 when nothing can be retried', async () => {
    const { agentId } = await personAndAgent(t);
    const { batchId } = await asSource(t, agentId, (ctx) => submitBatch(ctx, { name: 'Fine', items: [validArrival()] }, { channel: 'api' }));
    await expect(t.run((ctx) => retryBatch(ctx, batchId))).rejects.toMatchObject({ status: 409, message: 'Nothing in this batch can be retried.' });
  });
});
