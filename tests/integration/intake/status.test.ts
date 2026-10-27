import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountSummary } from '@/modules/accounts/db/schema';
import {
  accountForArrival,
  getArrival,
  getBatch,
  listArrivals,
  listBatchItems,
  listBatches,
  submitArrival,
  submitBatch,
  type ArrivalView,
} from '@/modules/intake';
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
const send = (sourceId: string, body: unknown = validArrival()) => asSource(t, sourceId, (ctx) => submitArrival(ctx, body, { channel: 'api' }));
const as = <T>(access: Access, fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access }));
const inPractice = (accountId: string, practiceId: string) =>
  t.run((ctx) => ctx.tx.update(accountSummary).set({ practiceIds: [practiceId] }).where(eq(accountSummary.accountId, accountId)));
const ids = (rows: ArrivalView[]) => rows.map((r) => r.id);

describe('batch status (SRC-E2-S3-AC1)', () => {
  it('returns counts, counts by stage and the rejections with external_ref, reason and detail', async () => {
    const items = [
      validArrival({ external_ref: 'st-1' }),
      { account: { domain: 'acme.com', external_ref: 'st-2' }, unknown_field: true },
      { account: { name: 'Waits', external_ref: 'st-3' } },
      validArrival({ external_ref: 'st-1' }),
    ];
    const out = await asSource(t, ash.agentId, (ctx) => submitBatch(ctx, { name: `Status ${++n}`, items }, { channel: 'webhook' }));
    await runOutbox(t.tenantId);

    const b = await asSource(t, ash.agentId, (ctx) => getBatch(ctx, out.batchId));
    expect(b).toMatchObject({
      id: out.batchId,
      status: 'processing',
      itemCount: 4,
      counts: { resolved: 1, rejected: 2, newAccounts: 1, alreadyKnown: 0 },
      stages: { received: 0, resolving: 0, waiting: 1, resolved: 1, rejected: 2 },
      sourceChain: { personSourceId: ash.personId, agentSourceId: ash.agentId },
    });
    expect(b!.rejections.map((r) => [r.externalRef, r.reason])).toEqual([
      ['st-2', 'invalid'],
      ['st-1', 'duplicate_in_batch'],
    ]);
    expect(b!.rejections[0]!.detail).toBeTruthy();

    const items2 = await asSource(t, ash.agentId, (ctx) => listBatchItems(ctx, out.batchId, { limit: 3 }));
    expect(items2!.data).toHaveLength(3);
    expect(items2!.nextCursor).toEqual(expect.any(String));
    const rest = await asSource(t, ash.agentId, (ctx) => listBatchItems(ctx, out.batchId, { cursor: items2!.nextCursor!, limit: 3 }));
    expect(rest!.data).toHaveLength(1);
    expect(rest!.nextCursor).toBeNull();
  });
});

describe('own_source (SRC-E2-S3-AC3)', () => {
  it('returns null for an arrival and a batch from another source, and hides them from lists', async () => {
    const mine = await send(ash.agentId);
    const theirs = await send(bo.agentId);
    const theirBatch = await asSource(t, bo.agentId, (ctx) => submitBatch(ctx, { name: `Bo run ${++n}`, items: [validArrival()] }, { channel: 'api' }));
    await runOutbox(t.tenantId);

    const forAsh = <T>(fn: (ctx: ModuleContext) => Promise<T>) => asSource(t, ash.agentId, fn);
    expect(await forAsh((ctx) => getArrival(ctx, mine.arrivalId))).toMatchObject({ id: mine.arrivalId, status: 'resolved' });
    expect(await forAsh((ctx) => getArrival(ctx, theirs.arrivalId))).toBeNull();
    expect(await forAsh((ctx) => accountForArrival(ctx, theirs.arrivalId))).toBeNull();
    expect(await forAsh((ctx) => getBatch(ctx, theirBatch.batchId))).toBeNull();
    expect(await forAsh((ctx) => listBatchItems(ctx, theirBatch.batchId))).toBeNull();
    expect(ids((await forAsh((ctx) => listArrivals(ctx, { limit: 200 }))).data)).not.toContain(theirs.arrivalId);
    expect((await forAsh((ctx) => listBatches(ctx, { limit: 200 }))).data.map((b) => b.id)).not.toContain(theirBatch.batchId);
    // The person sees what their agent sent; the other person does not.
    expect(await asSource(t, ash.personId, (ctx) => getArrival(ctx, mine.arrivalId))).not.toBeNull();
    expect(await asSource(t, bo.personId, (ctx) => getArrival(ctx, mine.arrivalId))).toBeNull();
    // The whole tenant sees both.
    expect(await t.run((ctx) => getArrival(ctx, theirs.arrivalId))).not.toBeNull();
  });
});

describe('arrival detail', () => {
  it('shows created_account, duplicate_of, the raw payload and the fact keys Scout does not know', async () => {
    const domain = validArrival().account.domain;
    const first = await send(ash.agentId, { account: { name: 'Detail Co', domain }, facts: { employees: 40, weird_thing: 'x' } });
    await runOutbox(t.tenantId);
    const second = await send(ash.agentId, { account: { name: 'Detail Co', domain } });
    await runOutbox(t.tenantId);

    const a = (await t.run((ctx) => getArrival(ctx, first.arrivalId)))!;
    const b = (await t.run((ctx) => getArrival(ctx, second.arrivalId)))!;
    expect(a).toMatchObject({ status: 'resolved', createdAccount: true, duplicateOf: null, unusedKeys: ['weird_thing'] });
    expect(a.payload).toMatchObject({ raw: { account: { name: 'Detail Co' } } });
    expect(b).toMatchObject({ createdAccount: false, duplicateOf: a.accountId, accountId: a.accountId, unusedKeys: [] });
    expect(await t.run((ctx) => accountForArrival(ctx, second.arrivalId))).toBe(a.accountId);
  });

  it('reports why a rejected arrival was rejected', async () => {
    const out = await send(ash.agentId, { account: { name: 'Vendorly', domain: validArrival().account.domain, industry: 'Software', description: 'An AI-powered software platform.' } });
    await runOutbox(t.tenantId);
    expect(await t.run((ctx) => getArrival(ctx, out.arrivalId))).toMatchObject({ status: 'rejected', reason: 'excluded', detail: 'Software vendor', createdAccount: true });
  });
});

describe('listArrivals', () => {
  it('lists the arrivals that touched an account, newest first, with paging', async () => {
    const domain = validArrival().account.domain;
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) {
      sent.push((await send(ash.agentId, { account: { name: 'Touched Co', domain } })).arrivalId);
      await runOutbox(t.tenantId);
    }
    const accountId = (await t.run((ctx) => getArrival(ctx, sent[0]!)))!.accountId!;
    const all = await t.run((ctx) => listArrivals(ctx, { accountId }));
    expect(ids(all.data)).toEqual([...sent].reverse());
    expect(all.nextCursor).toBeNull();

    const p1 = await t.run((ctx) => listArrivals(ctx, { accountId, limit: 2 }));
    const p2 = await t.run((ctx) => listArrivals(ctx, { accountId, limit: 2, cursor: p1.nextCursor! }));
    expect([...ids(p1.data), ...ids(p2.data)]).toEqual([...sent].reverse());
    expect(p2.nextCursor).toBeNull();
    await expect(t.run((ctx) => listArrivals(ctx, { cursor: 'nope' }))).rejects.toMatchObject({ status: 400 });
  });

  it('filters by status', async () => {
    const bad = await asSource(t, ash.agentId, (ctx) =>
      submitBatch(ctx, { name: `Bad ${++n}`, items: [{ account: { domain: 'acme.com' }, unknown_field: true }] }, { channel: 'webhook' }),
    );
    const out = bad.items[0]!;
    const rejected = await asSource(t, ash.agentId, (ctx) => listArrivals(ctx, { status: 'rejected', limit: 200 }));
    expect(ids(rejected.data)).toContain(out.arrivalId);
    expect(rejected.data.every((r) => r.status === 'rejected')).toBe(true);
  });
});

describe('account-based data limits (TEN-E3-S1-AC2)', () => {
  it('own_accounts sees resolved arrivals on accounts it may see, and pages through hidden rows', async () => {
    const mine = [(await send(ash.agentId)).arrivalId, (await send(ash.agentId)).arrivalId, (await send(ash.agentId)).arrivalId];
    await runOutbox(t.tenantId);
    // More hidden rows than one candidate page holds, all newer than the visible ones.
    const hidden = await asSource(t, bo.agentId, (ctx) =>
      submitBatch(ctx, { name: `Hidden ${++n}`, items: Array.from({ length: 55 }, () => validArrival()) }, { channel: 'api' }),
    );
    await runOutbox(t.tenantId, { maxRounds: 20 });

    const access: Access = { userId: 'usr_owner', sourceId: ash.personId, dataLimit: { kind: 'own_accounts' } };
    const p1 = await as(access, (ctx) => listArrivals(ctx, { limit: 2 }));
    expect(p1.data).toHaveLength(2);
    expect(p1.nextCursor).toEqual(expect.any(String));
    const p2 = await as(access, (ctx) => listArrivals(ctx, { limit: 2, cursor: p1.nextCursor! }));
    const seen = [...ids(p1.data), ...ids(p2.data)];
    expect(seen.filter((id) => mine.includes(id)).sort()).toEqual([...mine].sort());
    expect(seen).not.toEqual(expect.arrayContaining(hidden.items.map((i) => i.arrivalId).slice(0, 1)));
    expect(await as(access, (ctx) => getArrival(ctx, hidden.items[0]!.arrivalId))).toBeNull();
    expect(await as(access, (ctx) => getArrival(ctx, mine[0]!))).not.toBeNull();
  }, 60_000);

  it('practices sees resolved arrivals on accounts in those practices only', async () => {
    const inside = await send(ash.agentId);
    const outside = await send(ash.agentId);
    await runOutbox(t.tenantId);
    const accountId = (await t.run((ctx) => getArrival(ctx, inside.arrivalId)))!.accountId!;
    await inPractice(accountId, 'prc_status_a');

    const access: Access = { dataLimit: { kind: 'practices', ids: ['prc_status_a'] } };
    expect(ids((await as(access, (ctx) => listArrivals(ctx, { limit: 200 }))).data)).toEqual([inside.arrivalId]);
    expect(await as(access, (ctx) => getArrival(ctx, outside.arrivalId))).toBeNull();
    expect(await as(access, (ctx) => listArrivals(ctx, { accountId, limit: 200 }))).toMatchObject({ data: [{ id: inside.arrivalId }] });
  });

  it('any_of combines a source chain with account visibility', async () => {
    const own = await send(ash.agentId);
    const other = await send(bo.agentId);
    await runOutbox(t.tenantId);
    const otherAccount = (await t.run((ctx) => getArrival(ctx, other.arrivalId)))!.accountId!;
    await inPractice(otherAccount, 'prc_status_b');
    const access: Access = {
      sourceId: ash.agentId,
      dataLimit: { kind: 'any_of', limits: [{ kind: 'own_source' }, { kind: 'practices', ids: ['prc_status_b'] }] },
    };
    const seen = ids((await as(access, (ctx) => listArrivals(ctx, { limit: 200 }))).data);
    expect(seen).toEqual(expect.arrayContaining([own.arrivalId, other.arrivalId]));
    const third = await send(bo.agentId);
    await runOutbox(t.tenantId);
    expect(await as(access, (ctx) => getArrival(ctx, third.arrivalId))).toBeNull();
  });
});
