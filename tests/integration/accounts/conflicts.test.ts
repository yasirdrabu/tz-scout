import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { accountSummary, conflict, fact } from '@/modules/accounts/db/schema';
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
let clock = Date.parse('2026-10-01T00:00:00Z');
/** Each arrival is observed a minute after the previous one, so the newest one wins at equal trust. */
const tick = () => new Date((clock += 60_000));

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: tick(),
    sourceChain: { vendorSourceId: 'src_a' },
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

const send = (accountId: string | undefined, over: Partial<ArrivalForAccounts>) => t.run((ctx) => upsertFromArrival(ctx, arrival(over), accountId));
const from = (source: string) => ({ sourceChain: { vendorSourceId: source } });

const conflictsOf = (accountId: string) => t.run((ctx) => ctx.tx.select().from(conflict).where(eq(conflict.accountId, accountId)));
const countOf = async (accountId: string) =>
  (await t.run((ctx) => ctx.tx.select({ n: accountSummary.openConflictCount }).from(accountSummary).where(eq(accountSummary.accountId, accountId))))[0]?.n;
const factIdsOf = (accountId: string, key: string) =>
  t.run(async (ctx) =>
    (await ctx.tx.select({ id: fact.id }).from(fact).where(and(eq(fact.accountId, accountId), eq(fact.key, key)))).map((f) => f.id),
  );
const detected = async (accountId: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = 'accounts.conflict.detected'
        and payload->'data'->>'accountId' = ${accountId} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

async function seeded(over: Partial<ArrivalForAccounts>) {
  return send(undefined, { account: { name: 'Conflict Co', domain: domain() }, ...over });
}

describe('detecting conflicts (ACC-E3-S3)', () => {
  it('two sources more than 10% apart on contract value open one conflict', async () => {
    const a = await seeded({ ...from('src_a'), research: { contract_value_cents: 2_090_000_000 } });
    const b = await send(a.accountId, { ...from('src_b'), research: { contract_value_cents: 1_840_000_000 } });

    const rows = await conflictsOf(a.accountId);
    expect(rows).toHaveLength(1);
    const ids = await factIdsOf(a.accountId, 'contract_value_cents');
    expect([...rows[0]!.factIds].sort()).toEqual([...ids].sort());
    expect(rows[0]).toMatchObject({ key: 'contract_value_cents', status: 'open', personId: null });
    expect(rows[0]!.id).toMatch(/^cfl_/);
    expect(await countOf(a.accountId)).toBe(1);
    expect(b.conflictIds).toEqual([rows[0]!.id]);
    expect(a.conflictIds).toEqual([]);

    const events = await detected(a.accountId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.data).toMatchObject({ conflictId: rows[0]!.id, accountId: a.accountId, key: 'contract_value_cents' });
    expect([...(events[0]!.payload.data.sourceIds as string[])].sort()).toEqual(['src_a', 'src_b']);
  });

  it('employees 3,000 vs 3,500 is within tolerance: no conflict', async () => {
    const a = await seeded({ ...from('src_a'), account: { name: 'Within Co', domain: domain(), employees: 3000 } });
    const b = await send(a.accountId, { ...from('src_b'), account: { employees: 3500 } });
    expect(await conflictsOf(a.accountId)).toHaveLength(0);
    expect(b.conflictIds).toEqual([]);
    expect(await countOf(a.accountId)).toBe(0);
  });

  it('a third source with a third value joins the same conflict', async () => {
    const a = await seeded({ ...from('src_a'), research: { contract_value_cents: 2_090_000_000 } });
    await send(a.accountId, { ...from('src_b'), research: { contract_value_cents: 1_840_000_000 } });
    const c = await send(a.accountId, { ...from('src_c'), research: { contract_value_cents: 1_500_000_000 } });

    const rows = await conflictsOf(a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.factIds).toHaveLength(3);
    expect(c.conflictIds).toEqual([rows[0]!.id]);
    expect(await countOf(a.accountId)).toBe(1);
    const events = await detected(a.accountId);
    expect(events).toHaveLength(2);
    expect(events[1]!.payload.data.factIds).toHaveLength(3);
  });

  it('the same source sending a newer value supersedes its old one: no conflict', async () => {
    const a = await seeded({ ...from('src_a'), research: { contract_value_cents: 2_090_000_000 } });
    await send(a.accountId, { ...from('src_a'), research: { contract_value_cents: 1_840_000_000 } });
    expect(await conflictsOf(a.accountId)).toHaveLength(0);
    const statuses = await t.run((ctx) =>
      ctx.tx.select({ value: fact.value, status: fact.status }).from(fact).where(and(eq(fact.accountId, a.accountId), eq(fact.key, 'contract_value_cents'))),
    );
    expect(statuses.find((f) => f.value === 2_090_000_000)!.status).toBe('superseded');
  });

  it('an arrival that leaves an older disagreement untouched opens nothing (no backfill)', async () => {
    const a = await seeded({ ...from('src_a'), research: { contract_value_cents: 2_090_000_000 } });
    // A disagreement stored before detection existed: written straight to the fact table.
    await t.run((ctx) =>
      ctx.tx.insert(fact).values({
        id: newId('fct'),
        tenantId: ctx.tenantId,
        accountId: a.accountId,
        key: 'contract_value_cents',
        value: 1_000_000_000,
        valueType: 'number',
        kind: 'research',
        vendorSourceId: 'src_old',
        observedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'candidate',
      }),
    );
    const b = await send(a.accountId, { ...from('src_b'), account: { employees: 50 } });
    expect(b.conflictIds).toEqual([]);
    expect(await conflictsOf(a.accountId)).toHaveLength(0);
  });

  it('a person contact value from two sources opens a conflict for that person', async () => {
    const d = domain();
    const a = await seeded({ ...from('src_a'), people: [{ firstName: 'Ana', lastName: 'Silva', email: `ana@${d}`, title: 'CIO' }] });
    const b = await send(a.accountId, { ...from('src_b'), people: [{ firstName: 'Ana', lastName: 'Silva', email: `ana@${d}`, title: 'CFO' }] });
    const rows = await conflictsOf(a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'title', personId: a.personIds[0] });
    expect(b.conflictIds).toEqual([rows[0]!.id]);
    expect((await detected(a.accountId))[0]!.payload.data.personId).toBe(a.personIds[0]);
  });

  it('a losing source re-sending the value it lost is stored archived and opens nothing (Ruling 5)', async () => {
    const a = await seeded({ ...from('src_a'), research: { contract_value_cents: 2_090_000_000 } });
    // src_b's value lost an earlier conflict and was archived (Task 3 resolves; written by hand here).
    const lost = newId('fct');
    await t.run((ctx) =>
      ctx.tx.insert(fact).values({
        id: lost,
        tenantId: ctx.tenantId,
        accountId: a.accountId,
        key: 'contract_value_cents',
        value: 1_840_000_000,
        valueType: 'number',
        kind: 'research',
        vendorSourceId: 'src_b',
        observedAt: new Date('2026-01-01T00:00:00Z'),
        status: 'archived',
      }),
    );
    const b = await send(a.accountId, { ...from('src_b'), research: { contract_value_cents: 1_840_000_000 } });
    expect(b.conflictIds).toEqual([]);
    expect(await conflictsOf(a.accountId)).toHaveLength(0);
    const resent = await t.run((ctx) =>
      ctx.tx.select().from(fact).where(and(eq(fact.accountId, a.accountId), eq(fact.key, 'contract_value_cents'), eq(fact.vendorSourceId, 'src_b'))),
    );
    expect(resent).toHaveLength(2);
    expect(resent.every((f) => f.status === 'archived')).toBe(true);
  });
});

/** Resolves once `n` callers are waiting. */
function barrier(n: number): () => Promise<void> {
  let release!: () => void;
  const all = new Promise<void>((r) => (release = r));
  let waiting = 0;
  return () => {
    if (++waiting === n) release();
    return all;
  };
}

describe('concurrency (Review Focus 2)', () => {
  it('two concurrent arrivals disagreeing with the current value give exactly one open conflict', async () => {
    const a = await seeded({ ...from('src_a'), research: { contract_value_cents: 2_090_000_000 } });
    const ready = barrier(2);
    const race = (source: string, value: number) =>
      t.run(async (ctx) => {
        await ctx.tx.execute(sql`select 1`);
        await ready();
        return upsertFromArrival(ctx, arrival({ ...from(source), research: { contract_value_cents: value } }), a.accountId);
      });
    const [b, c] = await Promise.all([race('src_b', 1_500_000_000), race('src_c', 1_000_000_000)]);
    const rows = await conflictsOf(a.accountId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.factIds).toHaveLength(3);
    expect(b.conflictIds).toEqual([rows[0]!.id]);
    expect(c.conflictIds).toEqual([rows[0]!.id]);
    expect(await countOf(a.accountId)).toBe(1);
  });
});
