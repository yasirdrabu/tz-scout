import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { account, accountAlias } from '@/modules/accounts/db/schema';
import { matchName, trigramSimilarity } from '@/modules/accounts/domain/names';
import { findMatches, resolveAccountId } from '@/modules/accounts/services/match';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

const uniq = () => newId('acc').slice(-10).toLowerCase();
const domain = () => `${uniq()}.example.com`;
// Letters only, so each test's names are its own and cannot match another test's accounts.
const word = () => {
  const w = uniq().replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!);
  return w.charAt(0).toUpperCase() + w.slice(1);
};

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

const create = (over: Partial<ArrivalForAccounts>) => t.run((ctx) => upsertFromArrival(ctx, arrival(over)));
const find = (candidate: Parameters<typeof findMatches>[1]) => t.run((ctx) => findMatches(ctx, candidate));
const addAlias = (accountId: string, kind: string, value: string) =>
  t.run((ctx) => ctx.tx.insert(accountAlias).values({ tenantId: ctx.tenantId, accountId, kind, value }));

/** Task 9 does merges; here the survivor gets a merged_id alias and the merged account is archived. */
async function simulateMerge(survivorId: string, mergedId: string) {
  await addAlias(survivorId, 'merged_id', mergedId);
  await t.run((ctx) => ctx.tx.update(account).set({ archivedAt: new Date() }).where(eq(account.id, mergedId)));
}

describe('certain matches', () => {
  it('SRC-E3-S2-AC1 the same domain, after lower-casing, is certain', async () => {
    const d = domain();
    const a = await create({ account: { name: 'Miami Like Co', domain: d } });
    expect(await find({ domain: d.toUpperCase() })).toEqual([
      { accountId: a.accountId, confidence: 'certain', reason: 'Same domain, or a domain alias of an account' },
    ]);
  });

  it('a domain alias of an account is certain', async () => {
    const d = domain();
    const a = await create({ account: { name: 'Alias Holder', domain: domain() } });
    await addAlias(a.accountId, 'domain', d);
    expect((await find({ domain: d })).map((m) => [m.accountId, m.confidence])).toEqual([[a.accountId, 'certain']]);
  });

  it('the same company LinkedIn page is certain', async () => {
    const slug = uniq();
    const a = await create({ account: { name: 'Linked Co', domain: domain(), linkedinUrl: `https://www.linkedin.com/company/${slug}` } });
    expect(await find({ linkedinUrl: `https://www.linkedin.com/company/${slug}/` })).toEqual([
      { accountId: a.accountId, confidence: 'certain', reason: 'Same company LinkedIn URL' },
    ]);
  });

  it('a (system, id) seen before is certain', async () => {
    const id = uniq();
    const a = await create({ account: { name: 'External Co', domain: domain() }, externalIds: [{ system: 'apollo', id }] });
    expect(await find({ externalIds: [{ system: 'apollo', id }] })).toEqual([
      { accountId: a.accountId, confidence: 'certain', reason: 'Same (source, external_id) seen before on an account' },
    ]);
    expect(await find({ externalIds: [{ system: 'hubspot', id }] })).toEqual([]);
  });
});

describe('SRC-E3-S2-AC3 likely matches', () => {
  it('the same name and country on an account with no domain is likely', async () => {
    const w = word();
    const a = await create({ account: { name: `${w} Ridge Properties`, hqCountry: 'US' } });
    expect(await find({ name: `${w} Ridge Properties LLC`, country: 'US' })).toEqual([
      { accountId: a.accountId, confidence: 'likely', reason: 'Same normalised name and same country, account has no domain' },
    ]);
  });

  it('a different country, or an account with a domain, is not likely', async () => {
    const w = word();
    await create({ account: { name: `${w} Ridge Properties`, hqCountry: 'US' } });
    expect(await find({ name: `${w} Ridge Properties`, country: 'CA' })).toEqual([]);
    const w2 = word();
    await create({ account: { name: `${w2} Ridge Properties`, domain: domain(), hqCountry: 'US' } });
    expect(await find({ name: `${w2} Ridge Properties LLC`, country: 'US', domain: domain() })).toEqual([]);
  });
});

describe('possible matches', () => {
  const stored = 'Harborview Capital Partners';
  const incoming = 'Harborview Capital Partner';

  it('the pair under test has different match names and similarity of at least 0.85', () => {
    expect(matchName(stored)).not.toBe(matchName(incoming));
    expect(trigramSimilarity(stored, incoming)).toBeCloseTo(0.8966, 3);
  });

  it('similar names in the same state (Florida against FL) are possible', async () => {
    const w = word();
    const a = await create({ account: { name: `${w} ${stored}`, hqCountry: 'US', hqState: 'FL', hqCity: 'Tampa' } });
    expect(await find({ name: `${w} ${incoming}`, country: 'US', region: 'Florida', city: 'Orlando' })).toEqual([
      { accountId: a.accountId, confidence: 'possible', reason: 'Name is very similar and in the same state or city' },
    ]);
  });

  it('the same city also counts, ignoring case', async () => {
    const w = word();
    const a = await create({ account: { name: `${w} ${stored}`, hqCountry: 'US', hqState: 'FL', hqCity: 'Tampa' } });
    const out = await find({ name: `${w} ${incoming}`, country: 'US', region: 'Georgia', city: 'TAMPA' });
    expect(out.map((m) => m.accountId)).toEqual([a.accountId]);
  });

  it('the same pair in different states gives nothing', async () => {
    const w = word();
    await create({ account: { name: `${w} ${stored}`, hqCountry: 'US', hqState: 'FL', hqCity: 'Tampa' } });
    expect(await find({ name: `${w} ${incoming}`, country: 'US', region: 'Georgia', city: 'Atlanta' })).toEqual([]);
  });
});

describe('ACC-E1-S2-AC2 shell accounts', () => {
  it('a second arrival with the same email matches the shell account', async () => {
    const email = `${uniq()}@gmail.com`;
    const shell = await create({ soleProprietor: true, people: [{ firstName: 'Rosa', lastName: 'Diaz', email }] });
    expect(await find({ shellEmail: email.toUpperCase() })).toEqual([
      { accountId: shell.accountId, confidence: 'certain', reason: 'Same person email on a shell account' },
    ]);
  });

  it('the email of a person on a normal account is not a match', async () => {
    const email = `${uniq()}@gmail.com`;
    await create({ account: { name: 'Normal Co', domain: domain() }, people: [{ firstName: 'Al', email }] });
    expect(await find({ shellEmail: email })).toEqual([]);
  });
});

describe('archived accounts and merged ids', () => {
  it('an archived account never matches', async () => {
    const d = domain();
    const a = await create({ account: { name: 'Gone Co', domain: d } });
    await t.run((ctx) => ctx.tx.update(account).set({ archivedAt: new Date() }).where(eq(account.id, a.accountId)));
    expect(await find({ domain: d })).toEqual([]);
  });

  it('SRC-E3-S2-AC2 the merged account domain, held as an alias on the survivor, matches the survivor', async () => {
    const d = domain();
    const survivor = await create({ account: { name: 'Survivor Co', domain: domain() } });
    const merged = await create({ account: { name: 'Merged Co', domain: d } });
    await addAlias(survivor.accountId, 'domain', d);
    await simulateMerge(survivor.accountId, merged.accountId);
    expect((await find({ domain: d })).map((m) => m.accountId)).toEqual([survivor.accountId]);
  });

  it('resolveAccountId follows merged_id aliases, even through a chain', async () => {
    const s = await create({ account: { name: 'S Co', domain: domain() } });
    const m1 = await create({ account: { name: 'M1 Co', domain: domain() } });
    const m2 = await create({ account: { name: 'M2 Co', domain: domain() } });
    await simulateMerge(m1.accountId, m2.accountId);
    await simulateMerge(s.accountId, m1.accountId);
    expect(await t.run((ctx) => resolveAccountId(ctx, s.accountId))).toEqual({ id: s.accountId });
    expect(await t.run((ctx) => resolveAccountId(ctx, m2.accountId))).toEqual({ id: s.accountId, mergedInto: s.accountId });
    expect(await t.run((ctx) => resolveAccountId(ctx, 'acc_missing'))).toBeNull();
  });
});

describe('result shape', () => {
  it('is capped at 5, de-duplicated by account and in table order', async () => {
    const w = word();
    const d = domain();
    // One account matches by domain alias and would also match by name: it appears once, as certain.
    const both = await create({ account: { name: `${w} Harborview Capital Partners`, hqCountry: 'US', hqState: 'FL' } });
    await addAlias(both.accountId, 'domain', d);
    for (let i = 1; i <= 6; i++) {
      await create({ account: { name: `${w} Harborview Capital Partner${'z'.repeat(i)}`, hqCountry: 'US', hqState: 'FL' } });
    }
    const out = await find({ domain: d, name: `${w} Harborview Capital Partners`, country: 'US', region: 'FL' });
    expect(out).toHaveLength(5);
    expect(out[0]).toMatchObject({ accountId: both.accountId, confidence: 'certain' });
    expect(new Set(out.map((m) => m.accountId)).size).toBe(5);
    expect(out.slice(1).every((m) => m.confidence === 'possible')).toBe(true);
  });
});
