import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs } from '@/entry/worker';
import { approveRequest, createRequest, expireFlagged, failStuck } from '@/modules/enrichment';
import { request } from '@/modules/enrichment/db/schema';
import { sourceFeedback } from '@/modules/intake/db/schema';
import type { Principal } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { accountFrom, agentKey, as, enrichmentTenant, messagesFor, type Tenant } from './helpers';

let t: Tenant;
let owner: Principal;
let agentSourceId: string;

afterAll(closeDbs);
beforeAll(async () => {
  const e = await enrichmentTenant();
  t = e.t;
  owner = e.owner;
  agentSourceId = e.agentId;
});

const DAY = 86_400_000;
const firmo = { kind: 'company_firmographics' as const, providerKey: 'apollo' };

async function requestAged(p: Principal, accountId: string, days: number, input: Parameters<typeof createRequest>[3] = { ...firmo, reason: 'Size' }) {
  const { request: r } = await as(t, p, (ctx) => createRequest(ctx, p, accountId, input));
  await t.run((ctx) => ctx.tx.update(request).set({ createdAt: new Date(Date.now() - days * DAY) }).where(eq(request.id, r.id)));
  return r.id;
}

const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; message: string };
  }
  throw new Error('expected a rejection');
};

describe('expireFlagged (Ruling 7)', () => {
  it('cancels only requests flagged for 14 days or more, tells the requesting source and publishes cancelled', async () => {
    const key = agentKey(t, agentSourceId);
    const a = await accountFrom(t, agentSourceId);
    const b = await accountFrom(t, agentSourceId);
    const c = await accountFrom(t, agentSourceId);
    const old = await requestAged(key, a.accountId, 15);
    const young = await requestAged(key, b.accountId, 13);
    const oldApproved = await requestAged(owner, c.accountId, 20, firmo);

    const now = new Date();
    expect(await t.run((ctx) => expireFlagged(ctx, now))).toBe(1);

    const rows = await t.run((ctx) => ctx.tx.select().from(request).where(inArray(request.id, [old, young, oldApproved])));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(old)).toMatchObject({ status: 'cancelled', declineReason: 'expired' });
    expect(byId.get(young)!.status).toBe('flagged');
    expect(byId.get(oldApproved)!.status).toBe('approved');

    const cancelled = await messagesFor(t, 'enrichment.request.cancelled', old);
    expect(cancelled.map((m) => m.data)).toEqual([{ requestId: old, accountId: a.accountId, reason: 'expired' }]);
    const fb = await t.run((ctx) => ctx.tx.select().from(sourceFeedback).where(eq(sourceFeedback.accountId, a.accountId)));
    expect(fb.map((f) => [f.sourceId, f.kind, f.causeEventId])).toEqual([[agentSourceId, 'enrichment_expired', cancelled[0]!.id]]);

    // A second run finds nothing more.
    expect(await t.run((ctx) => expireFlagged(ctx, now))).toBe(0);
  });

  it('a request flagged exactly 14 days ago expires; one a second younger does not', async () => {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms);
    const a = await accountFrom(t, agentSourceId);
    const b = await accountFrom(t, agentSourceId);
    const key = agentKey(t, agentSourceId);
    const edge = await requestAged(key, a.accountId, 0);
    const younger = await requestAged(key, b.accountId, 0);
    await t.run((ctx) => ctx.tx.update(request).set({ createdAt: at(14 * DAY) }).where(eq(request.id, edge)));
    await t.run((ctx) => ctx.tx.update(request).set({ createdAt: at(14 * DAY - 1000) }).where(eq(request.id, younger)));
    expect(await t.run((ctx) => expireFlagged(ctx, now))).toBe(1);
    const rows = new Map((await t.run((ctx) => ctx.tx.select().from(request).where(inArray(request.id, [edge, younger])))).map((r) => [r.id, r]));
    expect(rows.get(edge)).toMatchObject({ status: 'cancelled', declineReason: 'expired' });
    expect(rows.get(younger)!.status).toBe('flagged');
    // A late approve reads as expired.
    const late = await reject(as(t, owner, (ctx) => approveRequest(ctx, owner, edge)));
    expect(late).toMatchObject({ status: 409, message: 'This request is already expired.' });
  });

  it('fails requests approved or running unchanged for a day, unless they wait on a limit (review I1)', async () => {
    const now = new Date();
    const waitingReason = 'Waiting for budget: Apollo monthly limit reached';
    const cases: [Partial<typeof request.$inferInsert>, number][] = [
      [{ status: 'running' }, 25],
      [{ status: 'approved' }, 24],
      [{ status: 'running' }, 23],
      [{ status: 'approved', waitingReason }, 72],
      [{ status: 'running', waitingReason }, 72],
      [{ status: 'completed' }, 72],
    ];
    // Every account first: making one runs the outbox, which would run an earlier request's job.
    const accounts: string[] = [];
    while (accounts.length < cases.length) accounts.push((await accountFrom(t, agentSourceId)).accountId);
    const ids: string[] = [];
    for (const [i, [set, hours]] of cases.entries()) {
      const { request: r } = await as(t, owner, (ctx) => createRequest(ctx, owner, accounts[i]!, firmo));
      await t.run((ctx) => ctx.tx.update(request).set({ ...set, updatedAt: new Date(now.getTime() - hours * 3_600_000) }).where(eq(request.id, r.id)));
      ids.push(r.id);
    }

    expect(await t.run((ctx) => failStuck(ctx, now))).toBe(2);
    const rows = new Map((await t.run((ctx) => ctx.tx.select().from(request).where(inArray(request.id, ids)))).map((r) => [r.id, r]));
    const stopped = { kind: 'unknown', message: 'This enrichment stopped without finishing. Try again.' };
    expect(rows.get(ids[0]!)).toMatchObject({ status: 'failed', error: stopped, finishedAt: now });
    expect(rows.get(ids[1]!)).toMatchObject({ status: 'failed', error: stopped });
    expect(ids.slice(2).map((id) => rows.get(id)!.status)).toEqual(['running', 'approved', 'running', 'completed']);
    const failed = await messagesFor(t, 'enrichment.request.failed', ids[0]!);
    expect(failed.map((m) => m.data)).toEqual([
      { requestId: ids[0], accountId: accounts[0], providerKey: 'apollo', errorKind: 'unknown', message: stopped.message, creditsUsed: 0, costCents: 0 },
    ]);
    expect(await t.run((ctx) => failStuck(ctx, now))).toBe(0);
  });

  it('is a worker job handler', () => {
    expect(jobs.some((j) => j.name === 'enrichment.request.expire')).toBe(true);
  });
});
