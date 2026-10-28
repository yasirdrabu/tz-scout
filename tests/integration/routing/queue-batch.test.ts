import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The real limit is 1,000 accounts; this makes a batch "too big" with no thousand rows.
vi.mock('@/modules/intake', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/intake')>();
  return { ...real, batchAccountIds: (ctx: Parameters<typeof real.batchAccountIds>[0], batchId: string, limit = 2) => real.batchAccountIds(ctx, batchId, limit) };
});

import { batchAccountIds, submitBatch } from '@/modules/intake';
import { countQueue, listQueue } from '@/modules/routing';
import { closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, personAndAgent } from '../intake/helpers';
import { asPerson, domain, routingTenant, type Tenant } from './helpers';

let t: Tenant;
beforeAll(async () => {
  t = await routingTenant();
});
afterAll(closeDbs);

const batchOf = async (n: number) => {
  const { agentId } = await personAndAgent(t, `Batch ${n}`);
  const items = Array.from({ length: n }, (_, i) => ({ external_ref: `r${i}`, account: { name: `Batch Co ${i}`, domain: domain() } }));
  const { batchId } = await asSource(t, agentId, (ctx) => submitBatch(ctx, { name: `Batch of ${n}`, items }, { channel: 'api' }));
  await runOutbox(t.tenantId);
  return batchId;
};

describe('the queue batch filter limit', () => {
  it('a batch within the limit filters as before', async () => {
    const batchId = await batchOf(2);
    expect((await asPerson(t, (ctx) => listQueue(ctx, { batchId }))).data).toHaveLength(2);
    expect(await asPerson(t, (ctx) => countQueue(ctx, { batchId }))).toBe(2);
  });

  it('a batch over the limit is a 400 on the list and the count, not a silent first page', async () => {
    const batchId = await batchOf(3);
    const failure = { status: 400, message: 'This batch has more than 1,000 accounts. Filter the queue another way.', errors: [{ path: 'batch_id' }] };
    await expect(asPerson(t, (ctx) => listQueue(ctx, { batchId }))).rejects.toMatchObject(failure);
    await expect(asPerson(t, (ctx) => countQueue(ctx, { batchId }))).rejects.toMatchObject(failure);
  });

  it('intake reports the overflow and keeps only the accounts within the limit', async () => {
    const batchId = await batchOf(3);
    const [two, three] = await Promise.all([
      asPerson(t, (ctx) => batchAccountIds(ctx, batchId, 2)),
      asPerson(t, (ctx) => batchAccountIds(ctx, batchId, 3)),
    ]);
    expect(two.accountIds).toHaveLength(2);
    expect(two.overflow).toBe(true);
    expect(three.accountIds).toHaveLength(3);
    expect(three.overflow).toBe(false);
  });
});
