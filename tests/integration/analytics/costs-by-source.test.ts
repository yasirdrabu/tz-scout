import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addManualLine, costsBySource, recordArrival, recordDeal, recordLine, recordStage, summary, voidLine } from '@/modules/analytics';
import { addDays, dayOf } from '@/modules/analytics/domain/budgets';
import { registerSource } from '@/modules/intake';
import { closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant, type Tenant } from '../intake/helpers';

afterAll(closeDbs);

const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
// The tenant is in UTC.
const dayAgo = (days: number) => addDays(dayOf(NOW, 'UTC'), -days);

async function tenant(): Promise<Tenant> {
  const t = await freshTenant();
  await runOutbox(t.tenantId);
  return t;
}

const person = (t: Tenant, name: string, parentId?: string) =>
  t.run(async (ctx) => (await registerSource(ctx, parentId ? { kind: 'agent', name, parentId } : { kind: 'person', name })).id);

const arrive = (t: Tenant, accountId: string, sourceId: string, daysAgo: number) =>
  t.run((ctx) => recordArrival(ctx, { accountId, sourceId, batchId: null, at: ago(daysAgo) }));
const stage = (t: Tenant, accountId: string, stageKey: string, daysAgo: number) =>
  t.run((ctx) => recordStage(ctx, { accountId, stageKey, at: ago(daysAgo), kind: 'flow' }));
const wonDeal = (t: Tenant, accountId: string, amountCents: number | null, daysAgo: number) =>
  t.run((ctx) =>
    recordDeal(ctx, { accountId, system: 'hubspot', dealExternalId: newId('evt'), status: 'won', amountCents, closedAt: ago(daysAgo), observedAt: ago(daysAgo) }),
  );
const manual = (t: Tenant, amountCents: number, daysAgo: number, sourceId: string | null = null) =>
  t.run((ctx) => addManualLine(ctx, { occurredOn: dayAgo(daysAgo), category: 'partner_fees', amountCents, note: null, sourceId }));
const usage = (t: Tenant, amountCents: number, daysAgo: number, accountId: string | null, sourceId: string | null = null) =>
  t.run((ctx) =>
    recordLine(ctx, { originEventId: newId('evt'), occurredOn: dayAgo(daysAgo), category: 'ai_usage', provider: 'anthropic', amountCents, accountId, sourceId }),
  );

describe('Costs summary R3b fields (Ruling 12)', () => {
  it('10 sent and 2 won in 90 days, $1,000 spend and won deals of $3,000 and no amount', async () => {
    const t = await tenant();
    const src = await person(t, 'Summary person');
    for (let i = 0; i < 10; i++) await arrive(t, `acc_s${i}`, src, 10);
    // Arrived long ago: not sent in the 90 days.
    await arrive(t, 'acc_old', src, 200);
    for (const a of ['acc_s0', 'acc_s1']) await stage(t, a, 'won', 5);
    await wonDeal(t, 'acc_s0', 300_000, 5);
    await wonDeal(t, 'acc_s1', null, 5);
    // A won deal closed before the 90 days adds no value.
    await wonDeal(t, 'acc_old', 999_999, 120);
    await manual(t, 100_000, 5);
    const voided = await manual(t, 50_000, 5);
    await t.run((ctx) => voidLine(ctx, voided.id, 'Duplicate'));

    const s = await t.run((ctx) => summary(ctx, NOW));
    expect(s).toMatchObject({ costPerSentCents: 10_000, costPerWonCents: 50_000, returnRatio: 3, targetCostPerWonCents: null });
  });

  it('with no spend, return is null', async () => {
    const t = await tenant();
    const src = await person(t, 'Nothing spent');
    await arrive(t, 'acc_n1', src, 3);
    const s = await t.run((ctx) => summary(ctx, NOW));
    expect(s).toMatchObject({ costPerSentCents: 0, costPerWonCents: null, returnRatio: null });
  });
});

describe('costsBySource (Rulings 6 and 12)', () => {
  let t: Tenant;
  let p: string;
  let a: string;
  let q: string;

  beforeAll(async () => {
    t = await tenant();
    p = await person(t, 'Pat');
    a = await person(t, 'Pat agent', p);
    q = await person(t, 'Quinn');
    await person(t, 'Rory'); // nothing sent and nothing spent: no row
    // a1 from the agent: assigned and won, with a $5,000 deal. a2 from the person: reviewed only. q1 from Quinn.
    await arrive(t, 'acc_a1', a, 10);
    await stage(t, 'acc_a1', 'assigned', 8);
    await stage(t, 'acc_a1', 'won', 3);
    await wonDeal(t, 'acc_a1', 500_000, 3);
    await arrive(t, 'acc_a2', p, 10);
    await stage(t, 'acc_a2', 'reviewed', 9);
    await arrive(t, 'acc_q1', q, 10);

    await usage(t, 100, 2, 'acc_a1'); // the account's first source (the agent), rolled up to Pat
    await manual(t, 200, 2, a); // the line's source, rolled up to Pat
    await manual(t, 250, 2, q);
    await manual(t, 400, 2); // no source, no account: shared
    await usage(t, 50, 2, 'acc_no_journey'); // an account outside any source: shared
    const voided = await manual(t, 999, 2, q);
    await t.run((ctx) => voidLine(ctx, voided.id, 'Wrong'));
    await manual(t, 777, 120, q); // before the 90 days
  });

  it('rolls children up into top-level rows, shared last, spends summing to the total', async () => {
    const r = await t.run((ctx) => costsBySource(ctx, NOW));
    expect(r.totalSpendCents).toBe(1_000);
    expect(r.rows).toEqual([
      { sourceId: p, name: 'Pat', kind: 'person', spendCents: 300, sharePct: 30, perSentCents: 150, perAssignedCents: 300, perWonCents: 300, returnRatio: 1666.7 },
      { sourceId: q, name: 'Quinn', kind: 'person', spendCents: 250, sharePct: 25, perSentCents: 250, perAssignedCents: null, perWonCents: null, returnRatio: 0 },
      { sourceId: null, name: 'Shared costs', spendCents: 450, sharePct: 45 },
    ]);
    expect(r.rows.reduce((s, row) => s + row.spendCents, 0)).toBe(r.totalSpendCents);
  });

  it('the summary spend is the same ledger total', async () => {
    const s = await t.run((ctx) => summary(ctx, NOW));
    expect(s.spend90dCents).toBe(1_000);
    expect(s).toMatchObject({ costPerSentCents: Math.round(1_000 / 3), costPerWonCents: 1_000, returnRatio: 500 });
  });
});
