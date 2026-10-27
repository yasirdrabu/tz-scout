import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { registerSourceInfoProvider, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account, accountSummary, fact, person, personRole, signal } from '@/modules/accounts/db/schema';
import { createPractice } from '@/modules/offers';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId); // tenant defaults: buying roles, exclusion rules, vendor phrases
});

afterEach(() => registerSourceInfoProvider(null));

const domain = () => `${newId('acc').slice(-10).toLowerCase()}.example.com`;

function arrival(over: Partial<ArrivalForAccounts> = {}): ArrivalForAccounts {
  return {
    arrivalId: newId('evt').replace('evt_', 'arr_'),
    receivedAt: new Date('2026-10-26T15:00:00Z'),
    sourceChain: { personSourceId: 'src_person1', agentSourceId: 'src_agent1' },
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

const events = async (accountId: string, type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type}
        and payload->'data'->>'accountId' = ${accountId} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

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

const rows = <T>(fn: Parameters<typeof t.run<T>>[0]) => t.run(fn);

describe('ACC-E1-S1 create and update from arrivals', () => {
  it('AC1 creates the account, 2 people, 3 facts and 1 signal in one call, with one event each', async () => {
    const d = domain();
    const out = await t.run((ctx) =>
      upsertFromArrival(
        ctx,
        arrival({
          account: { name: 'Harbor Point Holdings', domain: d, employees: 250 },
          people: [
            { firstName: 'Ana', lastName: 'Silva', email: 'ana@' + d, title: 'CIO', roleKeys: ['technical_buyer'] },
            { firstName: 'Ben', lastName: 'Okafor', title: 'COO' },
          ],
          signals: [{ kind: 'trigger', title: 'Harbor Point raised a Series B', occurredAt: new Date('2026-09-01T00:00:00Z') }],
        }),
      ),
    );
    expect(out.created).toBe(true);
    expect(out.personIds).toHaveLength(2);
    expect(out.existingPersonIds).toEqual([]);
    expect(out.signalIds).toHaveLength(1);

    const acc = await rows((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc[0]).toMatchObject({ name: 'Harbor Point Holdings', domain: d, employees: 250, matchName: 'harbor point holdings' });
    const accountFacts = await rows((ctx) =>
      ctx.tx.select().from(fact).where(and(eq(fact.accountId, out.accountId), sql`${fact.personId} is null`)),
    );
    expect(accountFacts.map((f) => f.key).sort()).toEqual(['domain', 'employees', 'name']);
    const allFacts = await rows((ctx) => ctx.tx.select().from(fact).where(eq(fact.accountId, out.accountId)));
    expect(out.factIds.sort()).toEqual(allFacts.map((f) => f.id).sort());

    const sig = await rows((ctx) => ctx.tx.select().from(signal).where(eq(signal.accountId, out.accountId)));
    expect(sig[0]).toMatchObject({ kind: 'trigger', type: 'funding' });
    const roles = await rows((ctx) => ctx.tx.select().from(personRole).where(eq(personRole.personId, out.personIds[0]!)));
    expect(roles).toEqual([expect.objectContaining({ roleKey: 'technical_buyer', origin: 'stated' })]);

    expect(await events(out.accountId, 'accounts.account.created')).toHaveLength(1);
    expect(await events(out.accountId, 'accounts.person.added')).toHaveLength(2);
    expect(await events(out.accountId, 'accounts.fact.recorded')).toHaveLength(allFacts.length);
    expect(await events(out.accountId, 'accounts.signal.recorded')).toHaveLength(1);
  });

  it('AC2 a second call with the account id and the same email and signal returns them as existing', async () => {
    const d = domain();
    const sig = { kind: 'trigger' as const, title: 'New CIO named', occurredAt: new Date('2026-09-02T00:00:00Z') };
    const first = await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ account: { name: 'Repeat Co', domain: d }, people: [{ firstName: 'Cy', email: 'cy@' + d }], signals: [sig] })),
    );
    const second = await t.run((ctx) =>
      upsertFromArrival(
        ctx,
        arrival({ people: [{ email: 'CY@' + d, title: 'CTO' }], signals: [{ ...sig, title: 'New CIO named!' }] }),
        first.accountId,
      ),
    );
    expect(second.created).toBe(false);
    expect(second.accountId).toBe(first.accountId);
    expect(second.existingPersonIds).toEqual(first.personIds);
    expect(second.existingSignalIds).toEqual(first.signalIds);
    const people = await rows((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, first.accountId)));
    expect(people).toHaveLength(1);
    expect(people[0]!.title).toBe('CTO');
    expect(await rows((ctx) => ctx.tx.select().from(signal).where(eq(signal.accountId, first.accountId)))).toHaveLength(1);
  });

  it('AC3 every fact and signal row carries the arrival id and source chain', async () => {
    const a = arrival({
      account: { name: 'Chain Co', domain: domain() },
      people: [{ firstName: 'Dee', lastName: 'Ng' }],
      signals: [{ kind: 'pain', title: 'Hiring 12 billing clerks', occurredAt: new Date('2026-09-03T00:00:00Z') }],
    });
    const out = await t.run((ctx) => upsertFromArrival(ctx, a));
    const facts = await rows((ctx) => ctx.tx.select().from(fact).where(eq(fact.accountId, out.accountId)));
    const sigs = await rows((ctx) => ctx.tx.select().from(signal).where(eq(signal.accountId, out.accountId)));
    for (const r of [...facts, ...sigs]) {
      expect(r).toMatchObject({ arrivalId: a.arrivalId, personSourceId: 'src_person1', agentSourceId: 'src_agent1', vendorSourceId: null });
    }
    expect(facts.some((f) => f.personId)).toBe(true);
  });
});

describe('ACC-E1-S2 shell accounts', () => {
  it('AC1 a sole proprietor with no company gets a shell account named after them, with the two owner roles', async () => {
    const out = await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ soleProprietor: true, people: [{ firstName: 'Rosa', lastName: 'Diaz', email: 'rosa@gmail.com' }] })),
    );
    const acc = await rows((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc[0]).toMatchObject({ name: 'Rosa Diaz', isShell: true, domain: null });
    const roles = await rows((ctx) => ctx.tx.select().from(personRole).where(eq(personRole.personId, out.personIds[0]!)));
    expect(roles.map((r) => r.roleKey).sort()).toEqual(['business_owner', 'commercial_buyer']);
  });
});

describe('practices, research tier, undated signals, exclusion, trust and sources', () => {
  it('a practice hint adds a practice; a later arrival without a hint keeps it', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Upsert Practice', slug: 'upsert-practice' }));
    const first = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Hinted', domain: domain() }, practiceHint: 'upsert-practice' })));
    await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { employees: 9 } }), first.accountId));
    const acc = await rows((ctx) => ctx.tx.select().from(account).where(eq(account.id, first.accountId)));
    expect(acc[0]!.practiceIds).toEqual([p.id]);
    const sum = await rows((ctx) => ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, first.accountId)));
    expect(sum[0]!.practiceIds).toEqual([p.id]);
    const updated = await events(first.accountId, 'accounts.account.updated');
    expect(updated.filter((e) => (e.payload.data.changedKeys as string[]).includes('practice_ids'))).toHaveLength(1);
  });

  it('researcher_tier A with a signal dated 2026-06-02 sets both research tier columns', async () => {
    const out = await t.run((ctx) =>
      upsertFromArrival(
        ctx,
        arrival({
          account: { name: 'Tiered', domain: domain() },
          research: { researcher_tier: 'A' },
          signals: [{ kind: 'trigger', title: 'Acquired a rival', occurredAt: new Date('2026-06-02T00:00:00Z') }],
        }),
      ),
    );
    const acc = await rows((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc[0]!.researchTier).toBe('A');
    expect(acc[0]!.researchTierSignalAt?.toISOString().slice(0, 10)).toBe('2026-06-02');
  });

  it('an undated research signal is stored with the arrival date', async () => {
    const out = await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ account: { name: 'Undated', domain: domain() }, signals: [{ kind: 'research', title: 'Reading about RCM' }] })),
    );
    const sig = await rows((ctx) => ctx.tx.select().from(signal).where(eq(signal.accountId, out.accountId)));
    expect(sig[0]!.occurredAt?.toISOString().slice(0, 10)).toBe('2026-10-26');
  });

  it('a software vendor arrival is excluded as software_vendor', async () => {
    const out = await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ account: { name: 'Vendorly', domain: domain(), industryKey: 'software' } })),
    );
    expect(out.excluded?.key).toBe('software_vendor');
    const acc = await rows((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc[0]!.excludedReasonKey).toBe('software_vendor');
    expect(await events(out.accountId, 'accounts.account.exclusion_changed')).toHaveLength(1);
  });

  it('the employees value from the more trusted chain is current, and trust is read once per chain', async () => {
    const calls: string[] = [];
    registerSourceInfoProvider({
      getTrust: async (_ctx, chain) => {
        calls.push(chain.agentSourceId ?? '');
        return chain.agentSourceId === 'src_high' ? 0.8 : 0.6;
      },
      sourcesForAccount: async () => [],
    });
    const high = { personSourceId: 'src_person1', agentSourceId: 'src_high' };
    const low = { personSourceId: 'src_person1', agentSourceId: 'src_low' };
    const first = await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ sourceChain: high, account: { name: 'Trusty', domain: domain(), employees: 800 } })),
    );
    calls.length = 0;
    await t.run((ctx) => upsertFromArrival(ctx, arrival({ sourceChain: low, account: { employees: 600 } }), first.accountId));
    const acc = await rows((ctx) => ctx.tx.select().from(account).where(eq(account.id, first.accountId)));
    expect(acc[0]!.employees).toBe(800);
    // One re-projection ran over facts from two chains: one getTrust call each.
    expect(calls.sort()).toEqual(['src_high', 'src_low']);
  });

  it('source_ids holds the chain sources right after the call', async () => {
    const out = await t.run((ctx) =>
      upsertFromArrival(
        ctx,
        arrival({ sourceChain: { personSourceId: 'src_p9', vendorSourceId: 'src_v9' }, account: { name: 'Sourced', domain: domain() } }),
      ),
    );
    const sum = await rows((ctx) => ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, out.accountId)));
    expect([...sum[0]!.sourceIds].sort()).toEqual(['src_p9', 'src_v9']);
  });
});

describe('concurrency (Review Focus 1, part)', () => {
  it('two concurrent calls for the same account and the same no-email person give one person', async () => {
    const base = await t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Racing', domain: domain() } })));
    // Both transactions are open (each on its own connection) before either starts the upsert.
    const ready = barrier(2);
    const add = () =>
      t.run(async (ctx) => {
        await ctx.tx.execute(sql`select 1`);
        await ready();
        return upsertFromArrival(ctx, arrival({ people: [{ firstName: 'Kai', lastName: 'Moreno', title: 'VP Finance' }] }), base.accountId);
      });
    const [a, b] = await Promise.all([add(), add()]);
    expect(a.personIds[0]).toBe(b.personIds[0]);
    const people = await rows((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, base.accountId)));
    expect(people).toHaveLength(1);
  });

  it('two concurrent creates for one new domain give one account', async () => {
    const d = domain();
    const ready = barrier(2);
    const create = () =>
      t.run(async (ctx) => {
        await ctx.tx.execute(sql`select 1`);
        await ready();
        return upsertFromArrival(ctx, arrival({ account: { name: 'Twin', domain: d } }));
      });
    const [a, b] = await Promise.all([create(), create()]);
    expect(a.accountId).toBe(b.accountId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
  });
});
