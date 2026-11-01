import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSummary } from '@/modules/accounts/db/schema';
import { attachFile, fileIdOf, getArrival, listBatchRows, readBatchFile, submitBatch } from '@/modules/intake';
import type { Access } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { closeDbs } from '@/platform/db/client';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, validArrival, type Tenant } from './helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };

afterAll(closeDbs);
beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
});

let n = 0;
const as = <T>(access: Access, fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access }));
const batchOf = (sourceId: string, items: unknown[]) => asSource(t, sourceId, (ctx) => submitBatch(ctx, { name: `Rows ${++n}`, items }, { channel: 'webhook' }));

/** The context with its transaction wrapped so every query it starts is counted. */
function counting(ctx: ModuleContext): { ctx: ModuleContext; count: () => number } {
  let queries = 0;
  const starts = new Set(['select', 'selectDistinct', 'selectDistinctOn', 'execute', 'insert', 'update', 'delete']);
  const tx = new Proxy(ctx.tx, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && starts.has(prop) && typeof value === 'function') {
        return (...args: unknown[]) => {
          queries++;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    },
  });
  return { ctx: { ...ctx, tx }, count: () => queries };
}

describe('GET /batches totals with mixed visibility', () => {
  it('counts the chain batches in full and the account-visible ones by their visible rows', async () => {
    const own = await batchOf(ash.agentId, [validArrival(), { account: { name: 'Waits for a website' } }]);
    const partly = await batchOf(bo.agentId, [validArrival(), validArrival()]);
    const hidden = await batchOf(bo.agentId, [validArrival()]);
    await runOutbox(t.tenantId);
    const visible = (await t.run((ctx) => getArrival(ctx, partly.items[0]!.arrivalId)))!.accountId!;
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ practiceIds: ['prc_rows'] }).where(eq(accountSummary.accountId, visible)));

    const access: Access = { dataLimit: { kind: 'any_of', limits: [{ kind: 'sources', ids: [ash.agentId] }, { kind: 'practices', ids: ['prc_rows'] }] } };
    const page = await as(access, (ctx) => listBatchRows(ctx, { limit: 200 }));
    const ids = page.data.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([own.batchId, partly.batchId]));
    expect(ids).not.toContain(hidden.batchId);
    expect(page.total).toBe(page.data.length);
    expect(page.data.find((b) => b.id === own.batchId)).toMatchObject({ statusKey: 'needs_attention', stages: { waiting: 1, resolved: 1 } });
    // Seen through one visible account: one row, complete, and no original file to download.
    expect(page.data.find((b) => b.id === partly.batchId)).toMatchObject({ statusKey: 'complete', itemCount: 1, stages: { resolved: 1, waiting: 0 }, files: [] });
    const counted = Object.fromEntries(['complete', 'in_progress', 'needs_attention', 'failed'].map((k) => [k, page.data.filter((b) => b.statusKey === k).length]));
    expect(page.meta.countsByStatus).toEqual(counted);
    expect(page.meta.attention.count).toBe(counted.needs_attention! + counted.failed!);

    const attention = await as(access, (ctx) => listBatchRows(ctx, { limit: 200, statusKeys: ['needs_attention'] }));
    expect(attention.data.map((b) => b.id)).toContain(own.batchId);
    expect(attention.data.map((b) => b.id)).not.toContain(partly.batchId);
    expect(attention.total).toBe(attention.data.length);
  });

  it('gives an account-visibility caller no original file, and the source still downloads it', async () => {
    const partly = await batchOf(bo.agentId, [validArrival()]);
    const stored = await asSource(t, bo.agentId, (ctx) => attachFile(ctx, partly.batchId, { fileName: 'list.csv', contentType: 'text/csv', bytes: new TextEncoder().encode('a,b,c') }));
    const fileId = fileIdOf(stored.storageKey);
    await runOutbox(t.tenantId);
    const visible = (await t.run((ctx) => getArrival(ctx, partly.items[0]!.arrivalId)))!.accountId!;
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ practiceIds: ['prc_file'] }).where(eq(accountSummary.accountId, visible)));
    const access: Access = { dataLimit: { kind: 'practices', ids: ['prc_file'] } };
    expect(await as(access, (ctx) => readBatchFile(ctx, partly.batchId, fileId))).toBeNull();
    const row = (await as(access, (ctx) => listBatchRows(ctx, { limit: 200 }))).data.find((b) => b.id === partly.batchId);
    expect(row?.files).toEqual([]);
    expect(await asSource(t, bo.agentId, (ctx) => readBatchFile(ctx, partly.batchId, fileId))).toMatchObject({ fileName: 'list.csv' });
    const own = (await asSource(t, bo.agentId, (ctx) => listBatchRows(ctx, { limit: 200 }))).data.find((b) => b.id === partly.batchId);
    expect(own?.files[0]?.id).toBe(fileId);
  });

  it('answers with the same number of queries for 4 account-visible batches and for 16', async () => {
    const { agentId } = await personAndAgent(t, 'Many');
    const access: Access = { dataLimit: { kind: 'practices', ids: ['prc_many'] } };
    const visibleBatch = async () => {
      const b = await batchOf(agentId, [validArrival()]);
      await runOutbox(t.tenantId);
      const account = (await t.run((ctx) => getArrival(ctx, b.items[0]!.arrivalId)))!.accountId!;
      await t.run((ctx) => ctx.tx.update(accountSummary).set({ practiceIds: ['prc_many'] }).where(eq(accountSummary.accountId, account)));
    };
    const measure = () =>
      as(access, async (ctx) => {
        const c = counting(ctx);
        await listBatchRows(c.ctx, { limit: 10, sourceIds: [agentId] });
        return c.count();
      });
    for (let i = 0; i < 4; i++) await visibleBatch();
    const few = await measure();
    for (let i = 0; i < 12; i++) await visibleBatch();
    const many = await measure();
    expect(many).toBe(few);
  });
});
