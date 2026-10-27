import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkArrivalCap, submitArrival, submitBatch, updateSource } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import { tenant } from '@/modules/tenancy/db/schema';
import { adminDb } from '@/platform/db/client';
import { ScoutError } from '@/platform/errors';
import { newId } from '@/platform/ids';
import { asSource, freshTenant, personAndAgent, validArrival, type Tenant } from './helpers';

let t: Tenant;

beforeAll(async () => {
  t = await freshTenant();
});

const stored = (sourceId: string) =>
  t.run(async (ctx) => (await ctx.tx.select().from(arrival).where(eq(arrival.closestSourceId, sourceId))).length);

async function agentWithCap(cap: number): Promise<string> {
  const { agentId } = await personAndAgent(t);
  await t.run((ctx) => updateSource(ctx, agentId, { dailyArrivalCap: cap }));
  return agentId;
}

const single = (sourceId: string, channel: 'api' | 'file' = 'api', body: unknown = validArrival()) =>
  asSource(t, sourceId, (ctx) => submitArrival(ctx, body, { channel }));

describe('daily cap (SRC-E1-S2-AC1, AC2)', () => {
  it('defaults to 500 a day', async () => {
    const { agentId } = await personAndAgent(t);
    const cap = await t.run((ctx) => checkArrivalCap(ctx, agentId));
    expect(cap).toMatchObject({ allowed: true, remaining: 500 });
  });

  it('gives the third single arrival 429 with Retry-After at the next tenant day, and stores nothing', async () => {
    const agentId = await agentWithCap(2);
    await single(agentId);
    await single(agentId);
    const before = Date.now();
    const err = (await single(agentId).catch((e: unknown) => e)) as ScoutError;
    expect(err).toBeInstanceOf(ScoutError);
    expect(err).toMatchObject({ slug: 'cap-reached', status: 429, message: 'This source has sent its daily limit of arrivals.' });
    const midnight = new Date(before);
    midnight.setUTCHours(24, 0, 0, 0);
    expect(err.extensions).toEqual({ resets_at: midnight.toISOString() });
    const retry = Number(err.headers!['retry-after']);
    expect(Math.abs(retry - (midnight.getTime() - before) / 1000)).toBeLessThan(5);
    expect(await stored(agentId)).toBe(2);
  });

  it('stores the third batch item and rejects it daily_cap_reached', async () => {
    const agentId = await agentWithCap(2);
    const out = await asSource(t, agentId, (ctx) =>
      submitBatch(ctx, { name: 'Run', items: [validArrival(), validArrival(), validArrival()] }, { channel: 'api' }),
    );
    expect(out.items.map((i) => i.status)).toEqual(['received', 'received', 'rejected']);
    const [third] = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, out.items[2]!.arrivalId)));
    expect(third).toMatchObject({ rejectReason: 'daily_cap_reached', status: 'rejected' });
    expect(third!.rejectDetail).toMatch(/^This source reached its daily limit\. Send this one again after .+\.$/);
  });

  it('lets exactly one of two concurrent submits through at count 1 with a cap of 2', async () => {
    const agentId = await agentWithCap(2);
    await single(agentId);
    // Each transaction holds on after its submit, so without the lock both would count 1.
    const slow = () =>
      asSource(t, agentId, async (ctx) => {
        const r = await submitArrival(ctx, validArrival(), { channel: 'api' });
        await new Promise((resolve) => setTimeout(resolve, 300));
        return r;
      });
    const results = await Promise.allSettled([slow(), slow()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ slug: 'cap-reached' });
    expect(await stored(agentId)).toBe(2);
  });
});

describe('file imports (Ruling 1)', () => {
  it("does not cap a person's import of 600 rows", async () => {
    const { personId } = await personAndAgent(t);
    await asSource(t, personId, async (ctx) => {
      for (let i = 0; i < 600; i++) await submitArrival(ctx, { account: { name: `Row ${i}` } }, { channel: 'file' });
    });
    expect(await stored(personId)).toBe(600);
    // The import does not use up the person's own daily limit either.
    expect(await t.run((ctx) => checkArrivalCap(ctx, personId))).toMatchObject({ allowed: true, remaining: 500 });
  });

  it("caps an agent's import", async () => {
    const agentId = await agentWithCap(1);
    await single(agentId, 'file', { account: { name: 'One' } });
    await expect(single(agentId, 'file', { account: { name: 'Two' } })).rejects.toMatchObject({ slug: 'cap-reached' });
  });
});

describe('the tenant day across the end of daylight time (Review Focus 4)', () => {
  it('resets at local midnight in America/New_York and points Retry-After there', async () => {
    const ny = await freshTenant();
    await adminDb.update(tenant).set({ timezone: 'America/New_York' }).where(eq(tenant.id, ny.tenantId));
    const { agentId } = await personAndAgent(ny);
    await ny.run((ctx) => updateSource(ctx, agentId, { dailyArrivalCap: 1 }));
    const at = (iso: string) =>
      ny.run((ctx) =>
        ctx.tx.insert(arrival).values({
          id: newId('arr'),
          tenantId: ctx.tenantId,
          agentSourceId: agentId,
          closestSourceId: agentId,
          principal: 'agent:k',
          channel: 'api',
          payload: {},
          payloadHash: 'h',
          receivedAt: new Date(iso),
        }),
      );
    const check = (iso: string) => ny.run((ctx) => checkArrivalCap(ctx, agentId, new Date(iso)));

    // 31 Oct, 23:30 EDT: the day ends at 1 Nov 00:00 EDT (04:00 UTC).
    await at('2026-11-01T03:30:00Z');
    expect(await check('2026-11-01T03:45:00Z')).toEqual({
      allowed: false,
      remaining: 0,
      resetsAt: new Date('2026-11-01T04:00:00Z'),
    });
    // 1 Nov is 25 hours long; it ends at 2 Nov 00:00 EST (05:00 UTC).
    expect(await check('2026-11-01T04:00:00Z')).toMatchObject({ allowed: true, resetsAt: new Date('2026-11-02T05:00:00Z') });
    await at('2026-11-02T04:30:00Z'); // 1 Nov, 23:30 EST
    expect(await check('2026-11-02T04:45:00Z')).toMatchObject({ allowed: false, resetsAt: new Date('2026-11-02T05:00:00Z') });
    expect(await check('2026-11-02T05:00:00Z')).toMatchObject({ allowed: true });
  });
});

describe('source status (SRC-E1-S2-AC4)', () => {
  it('a paused source gets 403 and stores nothing until resumed; an archived one gets 403', async () => {
    const { agentId } = await personAndAgent(t);
    await t.run((ctx) => updateSource(ctx, agentId, { status: 'paused' }));
    await expect(single(agentId)).rejects.toMatchObject({ status: 403, message: 'This source is paused' });
    await expect(
      asSource(t, agentId, (ctx) => submitBatch(ctx, { name: 'Run', items: [validArrival()] }, { channel: 'api' })),
    ).rejects.toMatchObject({ status: 403, message: 'This source is paused' });
    // The status is checked before the body.
    await expect(single(agentId, 'api', { account: { domain: 'not a domain' } })).rejects.toMatchObject({ status: 403 });
    await expect(asSource(t, agentId, (ctx) => submitBatch(ctx, { items: [] }, { channel: 'api' }))).rejects.toMatchObject({
      status: 403,
      message: 'This source is paused',
    });
    expect(await stored(agentId)).toBe(0);

    await t.run((ctx) => updateSource(ctx, agentId, { status: 'active' }));
    await single(agentId);
    expect(await stored(agentId)).toBe(1);

    await t.run((ctx) => updateSource(ctx, agentId, { status: 'archived' }));
    await expect(single(agentId)).rejects.toMatchObject({
      status: 403,
      message: 'This source is archived. Ask an owner for a new key.',
    });
    const rows = await t.run((ctx) =>
      ctx.tx.select().from(arrival).where(and(eq(arrival.closestSourceId, agentId), eq(arrival.tenantId, ctx.tenantId))),
    );
    expect(rows).toHaveLength(1);
  });
});
