import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GET as getArrivalRoute } from '@/http/routes/v1/arrivals/[id]/route';
import { GET as getBatchRoute } from '@/http/routes/v1/batches/[id]/route';
import { GET as feedbackRoute } from '@/http/routes/v1/feedback/route';
import { accountSummary } from '@/modules/accounts/db/schema';
import { arrival } from '@/modules/intake/db/schema';
import { getArrival, submitArrival, submitBatch } from '@/modules/intake';
import { statusChanged } from '@/modules/routing/contracts/events';
import { addMember } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { asSource } from '../intake/helpers';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { seedUser } from '../tenancy/helpers';
import { call, freshTenant, keyFor, personAndAgent, SEND, type Tenant } from './intake-helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };
let ashKey: string;
let ashStatusKey: string;
let boKey: string;
let ownerId: string;
let ownerName: string;
let n = 0;
const domain = () => `v1fb${Date.now().toString(36)}${++n}-example.com`;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
  ashKey = await keyFor(t, SEND, { sourceId: ash.agentId });
  ashStatusKey = await keyFor(t, [...SEND, 'status:read'], { sourceId: ash.agentId });
  boKey = await keyFor(t, SEND, { sourceId: bo.agentId });
  const u = await seedUser({ signedIn: true });
  await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' }));
  ownerId = u.id;
  ownerName = u.email.split('@')[0]!;
});
afterAll(closeDbs);

const get = (handler: Parameters<typeof call>[0], key: string, path: string) => call(handler, key, path);

async function declined() {
  const d = domain();
  const a = await asSource(t, ash.agentId, (ctx) => submitArrival(ctx, { account: { name: d, domain: d } }, { channel: 'api' }));
  await runOutbox(t.tenantId);
  const accountId = (await t.run((ctx) => getArrival(ctx, a.arrivalId)))!.accountId!;
  await t.run((ctx) =>
    ctx.tx.update(accountSummary).set({ stage: 'declined', reviewStatusKey: 'declined', ownerUserId: ownerId }).where(eq(accountSummary.accountId, accountId)),
  );
  await publishTestEvent(t.tenantId, statusChanged, {
    accountId,
    from: 'reviewed',
    to: 'declined',
    countsAsReviewed: true,
    isDeclined: true,
    returnsToSource: false,
    note: 'Too small',
    reasonKey: 'not_a_fit',
    by: 'usr_leader',
  });
  await runOutbox(t.tenantId);
  return { arrivalId: a.arrivalId, accountId };
}

describe('GET /v1/arrivals/{id}', () => {
  it('adds stage, review_status, feedback and, with status:read, owner_name', async () => {
    const { arrivalId } = await declined();
    const withName = await (await get(getArrivalRoute, ashStatusKey, `arrivals/${arrivalId}`)).json();
    expect(withName).toMatchObject({ stage: 'declined', review_status: 'declined', owner_name: ownerName });
    expect(withName.feedback).toHaveLength(1);
    expect(withName.feedback[0]).toMatchObject({ kind: 'declined_at_review', reason_key: 'not_a_fit', note: 'Too small', at: expect.any(String) });
    expect(withName.feedback[0].source_id).toBeUndefined();

    const without = await (await get(getArrivalRoute, ashKey, `arrivals/${arrivalId}`)).json();
    expect(without).toMatchObject({ stage: 'declined', review_status: 'declined', owner_name: null });
  });

  it('Review Focus 5: another source gets 404, never 403', async () => {
    const { arrivalId } = await declined();
    expect((await get(getArrivalRoute, boKey, `arrivals/${arrivalId}`)).status).toBe(404);
  });
});

describe('GET /v1/batches/{id}', () => {
  it('adds counts_by_stage', async () => {
    const d = domain();
    const out = await asSource(t, ash.agentId, (ctx) =>
      submitBatch(ctx, { name: 'Stage counts', items: [{ account: { name: d, domain: d } }] }, { channel: 'webhook' }),
    );
    await runOutbox(t.tenantId);
    const accountId = (await t.run((ctx) => ctx.tx.select({ id: arrival.accountId }).from(arrival).where(eq(arrival.batchId, out.batchId))))[0]!.id!;
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ stage: 'reviewed' }).where(eq(accountSummary.accountId, accountId)));
    const body = await (await get(getBatchRoute, ashKey, `batches/${out.batchId}`)).json();
    expect(body.counts_by_stage).toEqual({ reviewed: 1 });
  });
});

describe('GET /v1/feedback', () => {
  it('returns the principal own feedback with reason and note, and nothing of another source', async () => {
    const { accountId } = await declined();
    const mine = await (await get(feedbackRoute, ashKey, 'feedback?limit=200')).json();
    const row = mine.data.find((r: { account_id: string }) => r.account_id === accountId);
    expect(row).toMatchObject({ kind: 'declined_at_review', reason_key: 'not_a_fit', note: 'Too small', source_id: ash.agentId });
    const theirs = await (await get(feedbackRoute, boKey, 'feedback?limit=200')).json();
    expect(theirs.data.find((r: { account_id: string }) => r.account_id === accountId)).toBeUndefined();
  });

  it('pages with a cursor, filters by since, and refuses a bad since, a bad cursor and a key without arrivals:read', async () => {
    await declined();
    await declined();
    const first = await (await get(feedbackRoute, ashKey, 'feedback?limit=1')).json();
    expect(first.data).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = await (await get(feedbackRoute, ashKey, `feedback?limit=1&cursor=${first.next_cursor}`)).json();
    expect(second.data[0].id).not.toBe(first.data[0].id);
    expect((await (await get(feedbackRoute, ashKey, 'feedback?since=2099-01-01')).json()).data).toEqual([]);
    expect((await (await get(feedbackRoute, ashKey, 'feedback?since=2020-01-01T00:00:00Z&limit=200')).json()).data.length).toBeGreaterThan(0);
    expect((await get(feedbackRoute, ashKey, 'feedback?since=nope')).status).toBe(400);
    expect((await get(feedbackRoute, ashKey, 'feedback?since=2026-10-01T09:00:00')).status).toBe(400);
    expect((await get(feedbackRoute, ashKey, 'feedback?cursor=nope')).status).toBe(400);
    const noRead = await keyFor(t, ['arrivals:write'], { sourceId: ash.agentId });
    expect((await get(feedbackRoute, noRead, 'feedback')).status).toBe(403);
  });
});
