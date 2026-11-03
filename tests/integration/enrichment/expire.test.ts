import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jobs } from '@/entry/worker';
import { createRequest, expireFlagged } from '@/modules/enrichment';
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

  it('is a worker job handler', () => {
    expect(jobs.some((j) => j.name === 'enrichment.request.expire')).toBe(true);
  });
});
