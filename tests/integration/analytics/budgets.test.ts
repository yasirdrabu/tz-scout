import { and, asc, eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addManualLine, editManualLine, getBudgets, saveBudgets, summary, voidLine } from '@/modules/analytics';
import { budgetState } from '@/modules/analytics/db/schema';
import type { CostCategory } from '@/modules/integrations/contracts/costs';
import { createTenant } from '@/modules/tenancy';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import type { Actor, Envelope } from '@/platform/events/envelope';
import { inTenant, seedUser, uniqueSlug } from '../tenancy/helpers';

let admin: Actor;
let owner: { actor: Actor; email: string };

beforeAll(async () => {
  admin = (await seedUser({ admin: true })).actor;
  owner = await seedUser({ signedIn: true });
});

// Only Date is faked: 12:00 on 15 November in New York, unless a test moves it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-15T17:00:00Z'));
});
afterEach(() => vi.useRealTimers());

/** A fresh New York workspace per test, so levels and events start clean. */
async function workspace() {
  const t = await createTenant(admin, { slug: uniqueSlug(), name: 'Budgets', currency: 'USD', timezone: 'America/New_York', ownerEmail: owner.email });
  const run = <T>(fn: (ctx: ModuleContext) => Promise<T>) => inTenant(t.tenantId, owner.actor, fn);
  const levels = async () =>
    (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(asc(outbox.seq)))
      .map((r) => r.payload as Envelope<Record<string, unknown>>)
      .filter((e) => e.type === 'analytics.budget.level_changed')
      .map((e) => e.data);
  const add = (category: CostCategory, amountCents: number, occurredOn = '2026-11-10') => run((ctx) => addManualLine(ctx, { occurredOn, category, amountCents, note: null }));
  const budget = (month: string, category: CostCategory, amountCents: number) => run((ctx) => saveBudgets(ctx, month, [{ category, amountCents }]));
  return { tenantId: t.tenantId, run, levels, add, budget };
}

describe('levels', () => {
  it('crossing 90% publishes one alert; another line at 95% publishes nothing', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'lists_events', 10_000);
    await w.add('lists_events', 8_000);
    expect(await w.levels()).toEqual([]);
    await w.add('lists_events', 1_000);
    expect(await w.levels()).toEqual([{ category: 'lists_events', month: '2026-11', level: 'alert', spentCents: 9_000, budgetCents: 10_000, seq: 1 }]);
    await w.add('lists_events', 500);
    expect(await w.levels()).toHaveLength(1);
  });

  it('crossing 110% pauses AI usage; Partner fees stops at over', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'ai_usage', 10_000);
    await w.budget('2026-11', 'partner_fees', 10_000);
    await w.add('ai_usage', 11_000);
    await w.add('partner_fees', 12_000);
    await w.add('partner_fees', 1_000);
    expect(await w.levels()).toEqual([
      { category: 'ai_usage', month: '2026-11', level: 'paused', spentCents: 11_000, budgetCents: 10_000, seq: 1 },
      { category: 'partner_fees', month: '2026-11', level: 'over', spentCents: 12_000, budgetCents: 10_000, seq: 1 },
    ]);
  });

  it('voiding back below 90% publishes ok', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'data_vendors', 10_000);
    await w.add('data_vendors', 5_000);
    const big = await w.add('data_vendors', 6_000);
    await w.run((ctx) => voidLine(ctx, big.id, 'Booked twice'));
    expect((await w.levels()).map((e) => [e.level, e.spentCents, e.seq])).toEqual([
      ['paused', 11_000, 1],
      ['ok', 5_000, 2],
    ]);
  });

  it('raising the budget publishes the new level; saving the same budget publishes nothing', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'data_vendors', 10_000);
    await w.add('data_vendors', 10_500);
    await w.budget('2026-11', 'data_vendors', 20_000);
    await w.budget('2026-11', 'data_vendors', 20_000);
    expect(await w.levels()).toEqual([
      { category: 'data_vendors', month: '2026-11', level: 'over', spentCents: 10_500, budgetCents: 10_000, seq: 1 },
      { category: 'data_vendors', month: '2026-11', level: 'ok', spentCents: 10_500, budgetCents: 20_000, seq: 2 },
    ]);
  });

  it('a line dated in a past month moves no level', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'ai_usage', 1_000);
    await w.add('ai_usage', 5_000, '2026-10-31');
    expect(await w.levels()).toEqual([]);
  });

  it('two lines landing at once are both counted, and the change is published once', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'lists_events', 10_000);
    await w.add('lists_events', 1_000); // the month's level row is there already
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // The first change holds its transaction open after working out its level; the second lands meanwhile.
    await Promise.all([
      w.run(async (ctx) => {
        await addManualLine(ctx, { occurredOn: '2026-11-10', category: 'lists_events', amountCents: 4_000, note: null });
        await pause(300);
      }),
      pause(100).then(() => w.add('lists_events', 4_000)),
    ]);
    expect(await w.levels()).toEqual([{ category: 'lists_events', month: '2026-11', level: 'alert', spentCents: 9_000, budgetCents: 10_000, seq: 1 }]);
  });
});

describe('budgets', () => {
  it('a past month gets 409 "Past months can\'t be changed."', async () => {
    const w = await workspace();
    await expect(w.budget('2026-10', 'ai_usage', 1)).rejects.toMatchObject({ status: 409, message: "Past months can't be changed." });
  });

  it('a month carries the latest earlier budget forward; future months can be saved', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'ai_usage', 7_000);
    await w.budget('2027-01', 'ai_usage', 9_000);
    const dec = await w.run((ctx) => getBudgets(ctx, '2026-12'));
    expect(dec.budgets.find((b) => b.category === 'ai_usage')).toMatchObject({ amountCents: 7_000 });
    expect(dec.budgets.find((b) => b.category === 'partner_fees')).toMatchObject({ amountCents: null });
    expect(dec.totalCents).toBe(7_000);
    expect((await w.run((ctx) => getBudgets(ctx))).month).toBe('2026-11');
  });

  it('a negative budget and an unknown category are refused', async () => {
    const w = await workspace();
    await expect(w.budget('2026-11', 'ai_usage', -1)).rejects.toMatchObject({ status: 400 });
    await expect(w.budget('2026-11', 'hours' as CostCategory, 1)).rejects.toMatchObject({ status: 400 });
    await expect(w.run((ctx) => saveBudgets(ctx, 'November', []))).rejects.toMatchObject({ status: 400 });
  });
});

describe('month edge', () => {
  it('a line on the first day of a new month, in the tenant timezone, starts that month at ok', async () => {
    const w = await workspace();
    vi.setSystemTime(new Date('2026-12-01T04:00:00Z')); // 23:00 on 30 November in New York
    await w.budget('2026-11', 'ai_usage', 10_000);
    await w.add('ai_usage', 11_000, '2026-11-30');
    expect((await w.levels()).map((e) => [e.month, e.level])).toEqual([['2026-11', 'paused']]);

    vi.setSystemTime(new Date('2026-12-01T05:30:00Z')); // 00:30 on 1 December in New York
    await w.add('ai_usage', 2_000, '2026-12-01');
    // December carries the November budget and starts from ok: 20% publishes nothing.
    expect(await w.levels()).toHaveLength(1);
    const [dec] = await adminDb.select().from(budgetState).where(and(eq(budgetState.tenantId, w.tenantId), eq(budgetState.month, '2026-12')));
    expect(dec).toMatchObject({ category: 'ai_usage', level: 'ok' });
    // A late November line no longer moves any level.
    await w.add('ai_usage', 1_000, '2026-11-30');
    expect(await w.levels()).toHaveLength(1);
  });

  it('November paused, then a December line under 90% leaves December ok, in the levels and the summary; crossing 90% in December alerts December', async () => {
    const w = await workspace();
    vi.setSystemTime(new Date('2026-11-30T17:00:00Z'));
    await w.budget('2026-11', 'data_vendors', 10_000);
    await w.add('data_vendors', 12_000, '2026-11-30');
    vi.setSystemTime(new Date('2026-12-01T05:30:00Z')); // 00:30 on 1 December in New York
    await w.add('data_vendors', 8_900, '2026-12-01');
    expect((await w.levels()).map((e) => [e.month, e.level])).toEqual([['2026-11', 'paused']]);
    const s = await w.run((ctx) => summary(ctx, new Date()));
    expect(s.month).toBe('2026-12');
    expect(s.categories.find((c) => c.key === 'data_vendors')).toMatchObject({ spendMonthCents: 8_900, budgetCents: 10_000, level: 'ok' });
    await w.add('data_vendors', 200, '2026-12-01');
    expect((await w.levels()).map((e) => [e.month, e.level, e.spentCents])).toEqual([
      ['2026-11', 'paused', 12_000],
      ['2026-12', 'alert', 9_100],
    ]);
  });
});

describe('edits', () => {
  it('moving a manual line to another category recomputes both', async () => {
    const w = await workspace();
    await w.budget('2026-11', 'lists_events', 10_000);
    await w.budget('2026-11', 'partner_fees', 10_000);
    const line = await w.add('lists_events', 9_500);
    await w.run((ctx) => editManualLine(ctx, line.id, { category: 'partner_fees' }));
    expect((await w.levels()).map((e) => [e.category, e.level, e.spentCents])).toEqual([
      ['lists_events', 'alert', 9_500],
      ['lists_events', 'ok', 0],
      ['partner_fees', 'alert', 9_500],
    ]);
  });
});

describe('summary', () => {
  it('returns the tiles, the categories and 6 months, with budgets summed per month', async () => {
    const w = await workspace();
    vi.setSystemTime(new Date('2026-09-10T16:00:00Z'));
    await w.budget('2026-09', 'ai_usage', 10_000);
    vi.setSystemTime(new Date('2026-11-15T17:00:00Z'));
    await w.budget('2026-11', 'partner_fees', 50_000);
    await w.add('ai_usage', 3_000, '2026-11-02');
    await w.add('ai_usage', 2_000, '2026-10-20');
    await w.add('ai_usage', 1_000, '2026-08-01'); // more than 90 days ago
    const voided = await w.add('ai_usage', 9_999, '2026-11-03');
    await w.run((ctx) => voidLine(ctx, voided.id, 'Wrong'));
    await w.add('partner_fees', 40_000, '2026-11-10');
    await w.add('lists_events', 500, '2026-06-05');

    const s = await w.run((ctx) => summary(ctx, new Date()));
    expect(s).toMatchObject({ month: '2026-11', spendMonthCents: 43_000, budgetMonthCents: 60_000, spend90dCents: 45_000 });
    expect(s.categories).toEqual([
      { key: 'partner_fees', label: 'Partner fees', spend90dCents: 40_000, spendMonthCents: 40_000, budgetCents: 50_000, level: 'ok', pausable: false },
      { key: 'data_vendors', label: 'Data vendors', spend90dCents: 0, spendMonthCents: 0, budgetCents: null, level: 'ok', pausable: true },
      { key: 'agents_hosting', label: 'Agents and hosting', spend90dCents: 0, spendMonthCents: 0, budgetCents: null, level: 'ok', pausable: false },
      { key: 'lists_events', label: 'Lists and events', spend90dCents: 0, spendMonthCents: 0, budgetCents: null, level: 'ok', pausable: false },
      { key: 'ai_usage', label: 'AI usage', spend90dCents: 5_000, spendMonthCents: 3_000, budgetCents: 10_000, level: 'ok', pausable: true },
    ]);
    expect(s.months).toEqual([
      { month: '2026-06', spendCents: 500, budgetCents: 0 },
      { month: '2026-07', spendCents: 0, budgetCents: 0 },
      { month: '2026-08', spendCents: 1_000, budgetCents: 0 },
      { month: '2026-09', spendCents: 0, budgetCents: 10_000 },
      { month: '2026-10', spendCents: 2_000, budgetCents: 10_000 },
      { month: '2026-11', spendCents: 43_000, budgetCents: 60_000 },
    ]);
  });
});
