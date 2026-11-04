import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureVendorSource, getArrivalWithStatus, recordSourceFeedback, seedIntakeDefaults, submitArrival } from '@/modules/intake';
import { source, sourceFeedback } from '@/modules/intake/db/schema';
import { closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, freshTenant, personAndAgent, type Tenant } from './helpers';

let t: Tenant;
let ash: { personId: string; agentId: string };
let bo: { personId: string; agentId: string };

afterAll(closeDbs);
beforeAll(async () => {
  t = await freshTenant();
  await t.run((ctx) => seedIntakeDefaults(ctx));
  await runOutbox(t.tenantId);
  ash = await personAndAgent(t, 'Ash');
  bo = await personAndAgent(t, 'Bo');
});

let n = 0;
const domain = () => `sf${Date.now().toString(36)}${++n}-example.com`;
const send = (sourceId: string, d: string) =>
  asSource(t, sourceId, (ctx) => submitArrival(ctx, { account: { name: `Source fb ${d}`, domain: d } }, { channel: 'api' }));

async function accountFrom(sourceId: string, d = domain()) {
  const first = await send(sourceId, d);
  const second = await send(sourceId, d);
  await runOutbox(t.tenantId);
  const row = await asSource(t, sourceId, (ctx) => getArrivalWithStatus(ctx, first.arrivalId, { ownerName: false }));
  return { domain: d, accountId: row!.accountId!, arrivals: [first.arrivalId, second.arrivalId] };
}

const rowsFor = (accountId: string) => t.run((ctx) => ctx.tx.select().from(sourceFeedback).where(eq(sourceFeedback.accountId, accountId)));
const feedbackEvents = (accountId: string) =>
  t.run(async (ctx) =>
    (await ctx.tx.select().from(outbox).where(eq(outbox.tenantId, ctx.tenantId)))
      .map((r) => r.payload as { type: string; data: { accountId: string; sourceId: string; arrivalId: string | null; kind: string } })
      .filter((p) => p.type === 'intake.feedback.recorded' && p.data.accountId === accountId)
      .map((p) => p.data),
  );

describe('recordSourceFeedback (Ruling 10)', () => {
  it("tells only the named source, pinned to its latest resolved arrival for the account", async () => {
    const acc = await accountFrom(ash.agentId);
    await send(bo.agentId, acc.domain);
    await runOutbox(t.tenantId);
    const causeEventId = newId('evt');
    const added = await t.run((ctx) =>
      recordSourceFeedback(ctx, { sourceId: ash.agentId, accountId: acc.accountId, kind: 'enrichment_declined', note: 'Too costly', causeEventId }),
    );
    expect(added).toBe(1);
    const rows = await rowsFor(acc.accountId);
    expect(rows.map((r) => [r.sourceId, r.arrivalId, r.kind, r.note])).toEqual([[ash.agentId, acc.arrivals[1], 'enrichment_declined', 'Too costly']]);
    expect(await feedbackEvents(acc.accountId)).toEqual([
      { sourceId: ash.agentId, arrivalId: acc.arrivals[1], accountId: acc.accountId, kind: 'enrichment_declined', reasonKey: null, note: 'Too costly' },
    ]);
  });

  it('stores a null arrival when the source sent nothing for the account', async () => {
    const acc = await accountFrom(ash.agentId);
    const causeEventId = newId('evt');
    await t.run((ctx) => recordSourceFeedback(ctx, { sourceId: bo.agentId, accountId: acc.accountId, kind: 'enrichment_expired', note: null, causeEventId }));
    const rows = await rowsFor(acc.accountId);
    expect(rows.map((r) => [r.sourceId, r.arrivalId, r.kind])).toEqual([[bo.agentId, null, 'enrichment_expired']]);
    expect((await feedbackEvents(acc.accountId))[0]).toMatchObject({ sourceId: bo.agentId, arrivalId: null, kind: 'enrichment_expired' });
  });

  it('a replay of the same cause adds and publishes nothing', async () => {
    const acc = await accountFrom(ash.agentId);
    const f = { sourceId: ash.agentId, accountId: acc.accountId, kind: 'enrichment_declined' as const, note: 'No', causeEventId: newId('evt') };
    expect(await t.run((ctx) => recordSourceFeedback(ctx, f))).toBe(1);
    expect(await t.run((ctx) => recordSourceFeedback(ctx, f))).toBe(0);
    expect(await rowsFor(acc.accountId)).toHaveLength(1);
    expect(await feedbackEvents(acc.accountId)).toHaveLength(1);
  });
});

describe('ensureVendorSource', () => {
  it('returns the seeded vendor source by its key', async () => {
    const id = await t.run((ctx) => ensureVendorSource(ctx, 'apollo', 'Apollo'));
    const [row] = await t.run((ctx) => ctx.tx.select().from(source).where(eq(source.id, id)));
    expect(row).toMatchObject({ kind: 'vendor', name: 'Apollo', settings: { key: 'apollo' } });
  });

  it('creates a missing one once', async () => {
    const first = await t.run((ctx) => ensureVendorSource(ctx, 'website', 'Company website'));
    const again = await t.run((ctx) => ensureVendorSource(ctx, 'website', 'Company website'));
    expect(again).toBe(first);
    const rows = await t.run((ctx) =>
      ctx.tx.select().from(source).where(and(eq(source.tenantId, ctx.tenantId), eq(source.kind, 'vendor'), eq(source.name, 'Company website'))),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ initialReviewStatusKey: 'unvetted', settings: { key: 'website' } });
  });
});
