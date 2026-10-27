import { eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { editAccount, search, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account, accountAlias, accountSummary } from '@/modules/accounts/db/schema';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

const domain = () => `${newId('acc').slice(-10).toLowerCase()}.example.com`;

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: {},
    account: {},
    people: [],
    signals: [],
    facts: [],
    research: {},
    soleProprietor: false,
    externalIds: [],
    ...over,
  };
}
const seed = async (fields: ArrivalForAccounts['account'], over: Partial<ArrivalForAccounts> = {}) =>
  (await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { domain: domain(), ...fields }, ...over })))).accountId;

describe('search', () => {
  it('matches text on name, domain and alias, and leaves out archived accounts', async () => {
    const byName = await seed({ name: 'Zorblax Logistics' });
    const d = domain();
    const byDomain = await seed({ name: 'Plain Co', domain: d });
    const byAlias = await seed({ name: 'Aliased Co' });
    const archived = await seed({ name: 'Zorblax Archived' });
    await t.run((ctx) => ctx.tx.insert(accountAlias).values({ tenantId: ctx.tenantId, accountId: byAlias, kind: 'name', value: 'Quuxington Holdings' }));
    await t.run((ctx) => ctx.tx.update(account).set({ archivedAt: new Date() }).where(eq(account.id, archived)));
    const ids = async (text: string) => (await t.run((ctx) => search(ctx, { text }))).data.map((r) => r.accountId);
    expect(await ids('zorblax')).toEqual([byName]);
    expect(await ids(d.slice(0, 12))).toEqual([byDomain]);
    expect(await ids('quuxington')).toEqual([byAlias]);
    expect(await ids('100%')).toEqual([]);
  });

  it('filters on excluded, employees, country, tier, priority and owner', async () => {
    const excluded = await seed({ name: 'Filter Excluded Co', employees: 40, hqCountry: 'US' });
    const plain = await seed({ name: 'Filter Plain Co', employees: 400, hqCountry: 'CA' });
    const overridden = await seed({ name: 'Filter Overridden Co', employees: 400, hqCountry: 'CA' });
    await t.run((ctx) => ctx.tx.update(account).set({ excludedReasonKey: 'open_deal', excludedOverride: true }).where(eq(account.id, overridden)));
    await t.run((ctx) => ctx.tx.update(account).set({ excludedReasonKey: 'existing_customer' }).where(eq(account.id, excluded)));
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ tier: 'A', priority: 80 }).where(eq(accountSummary.accountId, plain)));
    const ids = async (q: Parameters<typeof search>[1]) =>
      (await t.run((ctx) => search(ctx, { text: 'Filter ', ...q }))).data.map((r) => r.accountId).sort();
    expect(await ids({ excluded: true })).toEqual([excluded]);
    expect(await ids({ excluded: false })).toEqual([overridden, plain].sort());
    expect(await ids({ employeesMin: 100 })).toEqual([overridden, plain].sort());
    expect(await ids({ employeesMax: 100 })).toEqual([excluded]);
    expect(await ids({ hqCountry: 'CA' })).toEqual([overridden, plain].sort());
    expect(await ids({ tier: 'A' })).toEqual([plain]);
    expect(await ids({ priorityMin: 50 })).toEqual([plain]);
    expect(await ids({ stage: 'won' })).toEqual([]); // CRM columns are empty until R1c
    expect(await ids({ reviewStatusKey: 'new' })).toEqual([]);
    expect(await ids({ ownerUserId: 'usr_nobody' })).toEqual([]);
    expect(await ids({ unassigned: true })).toEqual([excluded, overridden, plain].sort());
  });

  it('filters on signal kind since a date', async () => {
    const recent = await seed({ name: 'Sig Recent' }, { signals: [{ kind: 'trigger', title: 'Raised money', occurredAt: new Date('2026-10-01T00:00:00Z') }] });
    await seed({ name: 'Sig Old' }, { signals: [{ kind: 'trigger', title: 'Old news', occurredAt: new Date('2025-01-01T00:00:00Z') }] });
    const r = await t.run((ctx) => search(ctx, { text: 'Sig ', signalKind: 'trigger', signalSince: new Date('2026-09-01T00:00:00Z') }));
    expect(r.data.map((x) => x.accountId)).toEqual([recent]);
  });

  it('pages 120 accounts as 50, 50, 20 with no repeats, for every sort', async () => {
    const tenant = await freshTenant();
    await runOutbox(tenant.tenantId);
    await tenant.run(async (ctx) => {
      for (let i = 0; i < 120; i++) {
        const signals =
          i % 3 === 0 ? [] : [{ kind: 'trigger' as const, title: 's', occurredAt: new Date(Date.UTC(2026, 0, 1 + (i % 7))) }];
        await upsertFromArrival(ctx, arrival({ account: { name: `Paged ${String(i).padStart(3, '0')}`, domain: domain() }, signals }));
      }
    });
    await adminDb.execute(
      sql`update accounts.account_summary set priority = abs(hashtext(account_id)) % 5 where tenant_id = ${tenant.tenantId} and abs(hashtext(account_id)) % 4 <> 0`,
    );
    for (const sort of ['priority', 'last_signal', 'created', 'name'] as const) {
      const sizes: number[] = [];
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await tenant.run((ctx) => search(ctx, { text: 'Paged ', sort, ...(cursor ? { cursor } : {}) }));
        sizes.push(page.data.length);
        seen.push(...page.data.map((r) => r.accountId));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(sizes, sort).toEqual([50, 50, 20]);
      expect(new Set(seen).size, sort).toBe(120);
    }
    const byName = await tenant.run((ctx) => search(ctx, { text: 'Paged ', sort: 'name', limit: 3 }));
    expect(byName.data.map((r) => r.name)).toEqual(['Paged 000', 'Paged 001', 'Paged 002']);
  });

  it('rejects a cursor it did not issue', async () => {
    await expect(t.run((ctx) => search(ctx, { cursor: 'not-a-cursor' }))).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a forged cursor whose key does not fit the sort, and ignores a non-finite limit', async () => {
    const forge = (sort: string, key: string | null) => Buffer.from(JSON.stringify({ sort, key, id: 'acc_x' })).toString('base64url');
    for (const [sort, key] of [['priority', 'abc'], ['created', 'abc'], ['last_signal', '1; drop'], ['priority', '99999999999']] as const) {
      await expect(t.run((ctx) => search(ctx, { sort, cursor: forge(sort, key) })), sort).rejects.toMatchObject({ status: 400 });
    }
    expect((await t.run((ctx) => search(ctx, { limit: Number.NaN }))).data.length).toBeGreaterThan(0);
  });

  it('shows a pinned name edit in search results', async () => {
    const id = await seed({ name: 'Before Edit' });
    await t.run((ctx) => editAccount({ ...ctx, access: { userId: 'usr_e', dataLimit: { kind: 'all' } } }, id, { name: 'After Edit Name' }));
    const r = await t.run((ctx) => search(ctx, { text: 'After Edit Name' }));
    expect(r.data.map((x) => x.accountId)).toEqual([id]);
  });
});

// ACC-E8-S1-AC2: slow, runs in CI only.
describe.skipIf(!process.env.CI)('search performance', () => {
  it('returns over 10,000 summaries in under 500 ms p95 across 20 runs', async () => {
    const tenant = await freshTenant();
    await runOutbox(tenant.tenantId);
    await adminDb.execute(sql`
      with a as (
        insert into accounts.account (id, tenant_id, name, match_name, domain, hq_country)
        select 'acc_perf' || g, ${tenant.tenantId}, 'Perf Co ' || g, 'perf co ' || g, 'perf' || g || '.example.com', 'US'
        from generate_series(1, 10000) g returning id
      )
      insert into accounts.account_summary (tenant_id, account_id, priority, tier, source_ids, practice_ids)
      select ${tenant.tenantId}, id, abs(hashtext(id)) % 100, 'B', array['src_perf'], '{}' from a`);
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await tenant.run((ctx) => search(ctx, { text: 'Perf Co', tier: 'B', priorityMin: 10, limit: 50 }));
      times.push(performance.now() - start);
    }
    times.sort((x, y) => x - y);
    expect(times[Math.ceil(times.length * 0.95) - 1]!).toBeLessThan(500);
  }, 120_000);
});
