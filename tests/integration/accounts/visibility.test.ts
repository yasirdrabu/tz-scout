import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  checkExclusion,
  editAccount,
  editPerson,
  filterVisibleAccountIds,
  getAccount,
  getAccountForScoring,
  getFacts,
  getSignals,
  listPeople,
  mergeAccounts,
  setPractices,
  registerSourceAccessProvider,
  search,
  upsertFromArrival,
  type ArrivalForAccounts,
} from '@/modules/accounts';
import { accountAlias, accountSummary, person } from '@/modules/accounts/db/schema';
import type { DataLimit } from '@/platform/access';
import type { ModuleContext } from '@/platform/context';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

afterEach(() => registerSourceAccessProvider(null));

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

/** Seeds an account carrying the given source chain; returns its id. */
async function seed(name: string, sourceChain: ArrivalForAccounts['sourceChain']): Promise<string> {
  const out = await t.run((ctx) => upsertFromArrival(ctx, arrival({ sourceChain, account: { name, domain: domain() } })));
  return out.accountId;
}

const as = <T>(access: ModuleContext['access'], fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access }));
const limited = (dataLimit: DataLimit, extra: { userId?: string; sourceId?: string; childSourceIds?: string[] } = {}) => ({ ...extra, dataLimit });
const idsOf = async (access: ModuleContext['access'], ids: string[]) => {
  const rows = await as(access, (ctx) => search(ctx, { limit: 200 }));
  return rows.data.map((r) => r.accountId).filter((id) => ids.includes(id));
};

describe('data limits (TEN-E3-S1-AC2)', () => {
  it('own_source sees only accounts its source sent, in search and getAccount', async () => {
    const mine = await seed('Own Source Mine', { agentSourceId: 'src_own_a' });
    const other = await seed('Own Source Other', { agentSourceId: 'src_own_b' });
    const access = limited({ kind: 'own_source' }, { sourceId: 'src_own_a' });
    expect(await idsOf(access, [mine, other])).toEqual([mine]);
    expect(await as(access, (ctx) => getAccount(ctx, mine))).toMatchObject({ id: mine });
    expect(await as(access, (ctx) => getAccount(ctx, other))).toBeNull();
    expect(await as(access, (ctx) => filterVisibleAccountIds(ctx, [mine, other, 'acc_missing']))).toEqual([mine]);
  });

  it('own_source of a person sees the account its agent sent', async () => {
    registerSourceAccessProvider({
      childSources: async (_c, ids) => (ids.includes('src_p1') ? ['src_p1_agent'] : []),
      personSourceFor: async () => undefined,
    });
    const viaAgent = await seed('Via Agent', { personSourceId: 'src_p1', agentSourceId: 'src_p1_agent' });
    const agentOnly = await seed('Agent Only', { agentSourceId: 'src_p1_agent' });
    const other = await seed('Other Person', { agentSourceId: 'src_p2_agent' });
    const access = limited({ kind: 'own_source' }, { sourceId: 'src_p1' });
    expect((await idsOf(access, [viaAgent, agentOnly, other])).sort()).toEqual([viaAgent, agentOnly].sort());
  });

  it('sources naming a person source sees its agent accounts', async () => {
    registerSourceAccessProvider({
      childSources: async (_c, ids) => (ids.includes('src_p3') ? ['src_p3_agent'] : []),
      personSourceFor: async () => undefined,
    });
    const a = await seed('Sources Agent', { agentSourceId: 'src_p3_agent' });
    const b = await seed('Sources Other', { agentSourceId: 'src_elsewhere' });
    expect(await idsOf(limited({ kind: 'sources', ids: ['src_p3'] }), [a, b])).toEqual([a]);
  });

  it('practices sees accounts in those practices', async () => {
    const a = await seed('Practice In', {});
    const b = await seed('Practice Out', {});
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ practiceIds: ['prc_x'] }).where(eq(accountSummary.accountId, a)));
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ practiceId: 'prc_y' }).where(eq(accountSummary.accountId, b)));
    expect(await idsOf(limited({ kind: 'practices', ids: ['prc_x'] }), [a, b])).toEqual([a]);
    expect(await idsOf(limited({ kind: 'practices', ids: ['prc_y'] }), [a, b])).toEqual([b]);
  });

  it('own_accounts sees owned accounts and those imported through the seller person source', async () => {
    const imported = await seed('Imported By Me', { personSourceId: 'src_seller' });
    const owned = await seed('Owned By Me', {});
    const other = await seed('Not Mine', { personSourceId: 'src_someone' });
    await t.run((ctx) => ctx.tx.update(accountSummary).set({ ownerUserId: 'usr_seller' }).where(eq(accountSummary.accountId, owned)));
    const access = limited({ kind: 'own_accounts' }, { userId: 'usr_seller', sourceId: 'src_seller' });
    expect((await idsOf(access, [imported, owned, other])).sort()).toEqual([imported, owned].sort());
  });

  it('any_of is the union of its parts, all and unset see everything', async () => {
    const a = await seed('AnyOf A', { agentSourceId: 'src_any_a' });
    const b = await seed('AnyOf B', { agentSourceId: 'src_any_b' });
    const c = await seed('AnyOf C', { agentSourceId: 'src_any_c' });
    const access = limited({
      kind: 'any_of',
      limits: [
        { kind: 'sources', ids: ['src_any_a'] },
        { kind: 'sources', ids: ['src_any_b'] },
      ],
    });
    expect((await idsOf(access, [a, b, c])).sort()).toEqual([a, b].sort());
    expect((await idsOf(limited({ kind: 'all' }), [a, b, c])).sort()).toEqual([a, b, c].sort());
    expect((await idsOf(undefined, [a, b, c])).sort()).toEqual([a, b, c].sort());
  });
});

describe('hidden accounts', () => {
  const sellerAccess = limited({ kind: 'own_source' }, { userId: 'usr_ltd', sourceId: 'src_ltd' });

  it('reads return empty or null, and a merged id whose survivor is hidden returns null', async () => {
    const hidden = await seed('Hidden Reads', { agentSourceId: 'src_hidden' });
    const gone = newId('acc');
    await t.run((ctx) => ctx.tx.insert(accountAlias).values({ tenantId: ctx.tenantId, accountId: hidden, kind: 'merged_id', value: gone }));
    expect(await as(sellerAccess, (ctx) => getAccount(ctx, gone))).toBeNull();
    expect(await as(sellerAccess, (ctx) => getSignals(ctx, hidden))).toEqual([]);
    expect(await as(sellerAccess, (ctx) => getFacts(ctx, hidden))).toEqual([]);
    expect(await as(sellerAccess, (ctx) => listPeople(ctx, hidden))).toEqual([]);
    expect(await as(sellerAccess, (ctx) => getAccountForScoring(ctx, hidden))).toBeNull();
    expect(await as(sellerAccess, (ctx) => checkExclusion(ctx, hidden))).toBeNull();
    expect(await as(undefined, (ctx) => getAccount(ctx, gone))).toMatchObject({ id: hidden });
  });

  it('empty any_of, practices and sources see nothing', async () => {
    const a = await seed('Empty Limits', { agentSourceId: 'src_empty' });
    for (const limit of [{ kind: 'any_of', limits: [] }, { kind: 'practices', ids: [] }, { kind: 'sources', ids: [] }] as DataLimit[]) {
      expect(await idsOf(limited(limit), [a]), limit.kind).toEqual([]);
    }
  });

  it('a limited principal gets 404 editing or merging an account it cannot see', async () => {
    const mine = await seed('Visible Mine', { agentSourceId: 'src_ltd' });
    const hidden = await seed('Hidden Target', { agentSourceId: 'src_hidden2' });
    const hiddenPerson = (
      await t.run(async (ctx) => {
        await upsertFromArrival(
          ctx,
          arrival({ sourceChain: { agentSourceId: 'src_hidden2' }, account: { name: 'Hidden Target', domain: (await getAccount(ctx, hidden))!.domain! }, people: [{ firstName: 'Hi', email: 'hi@hidden.example.com' }] }),
        );
        return ctx.tx.select({ id: person.id }).from(person).where(eq(person.accountId, hidden));
      })
    )[0]!.id;
    const notFound = { status: 404 };
    await expect(as(sellerAccess, (ctx) => mergeAccounts(ctx, mine, hidden))).rejects.toMatchObject(notFound);
    await expect(as(sellerAccess, (ctx) => mergeAccounts(ctx, hidden, mine))).rejects.toMatchObject(notFound);
    await expect(as(sellerAccess, (ctx) => editAccount(ctx, hidden, { employees: 5 }))).rejects.toMatchObject(notFound);
    await expect(as(sellerAccess, (ctx) => editPerson(ctx, hiddenPerson, { title: 'CEO' }))).rejects.toMatchObject(notFound);
    await expect(as(sellerAccess, (ctx) => setPractices(ctx, hidden, [], 'person'))).rejects.toMatchObject(notFound);
    await as(sellerAccess, (ctx) => setPractices(ctx, hidden, ['prc_h'], 'hint')); // the intake path is unfiltered
    await as(sellerAccess, (ctx) => editAccount(ctx, mine, { employees: 5 })); // its own account still works
  });
});
