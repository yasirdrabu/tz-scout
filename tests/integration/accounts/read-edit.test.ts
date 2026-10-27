import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  archiveSignal,
  checkExclusion,
  convertShell,
  editAccount,
  editPerson,
  findMatches,
  getAccount,
  getAccountForScoring,
  getAccounts,
  getFacts,
  getSignals,
  listPeople,
  overrideExclusion,
  pinPrimary,
  registerSourceInfoProvider,
  removeExclusionOverride,
  setPractices,
  upsertFromArrival,
  type ArrivalForAccounts,
} from '@/modules/accounts';
import { account, accountAlias, fact, person, personRole } from '@/modules/accounts/db/schema';
import { createPractice } from '@/modules/offers';
import type { ModuleContext } from '@/platform/context';
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
const personAccess = { userId: 'usr_editor', sourceId: 'src_editor', dataLimit: { kind: 'all' as const } };
/** Runs as a signed-in person who has a person source. */
const asPerson = <T>(fn: (ctx: ModuleContext) => Promise<T>) => t.run((ctx) => fn({ ...ctx, access: personAccess }));

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

const eventsOf = async (accountId: string, type: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type}
        and payload->'data'->>'accountId' = ${accountId} order by seq`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

const seed = (over: Partial<ArrivalForAccounts> = {}) =>
  t.run((ctx) => upsertFromArrival(ctx, arrival({ account: { name: 'Read Edit Co', domain: domain(), employees: 100 }, ...over })));

describe('reads', () => {
  it('getAccount, getAccounts, listPeople and getFacts follow merged ids', async () => {
    const d = domain();
    const a = await seed({
      account: { name: 'Read Edit Co', domain: d, employees: 100 },
      people: [{ firstName: 'Ana', lastName: 'Silva', email: `ana@${d}`, title: 'CIO', roleKeys: ['technical_buyer'] }],
    });
    const b = await seed();
    await t.run((ctx) =>
      ctx.tx.insert(accountAlias).values({ tenantId: ctx.tenantId, accountId: a.accountId, kind: 'merged_id', value: b.accountId }),
    );
    const view = await t.run((ctx) => getAccount(ctx, b.accountId));
    expect(view).toMatchObject({ id: a.accountId, mergedInto: a.accountId, name: 'Read Edit Co', employees: 100 });
    expect(view!.people[0]).toMatchObject({ firstName: 'Ana', roles: [{ key: 'technical_buyer', origin: 'stated' }] });
    expect(await t.run((ctx) => getAccount(ctx, 'acc_missing'))).toBeNull();
    const many = await t.run((ctx) => getAccounts(ctx, [a.accountId, 'acc_missing']));
    expect(many.map((x) => x.id)).toEqual([a.accountId]);
    expect(await t.run((ctx) => listPeople(ctx, a.accountId))).toHaveLength(1);
    const current = await t.run((ctx) => getFacts(ctx, a.accountId, { key: 'employees' }));
    expect(current.map((f) => f.value)).toEqual([100]);
  });

  it('getAccountForScoring returns practices, facts, people, signals, tier and the exclusion flags', async () => {
    const p = await t.run((ctx) => createPractice(ctx, { name: 'Scoring Practice', slug: 'scoring-practice' }));
    const out = await seed({
      practiceHint: 'scoring-practice',
      people: [{ firstName: 'Cy', title: 'CTO', seniority: 'chief', roleKeys: ['technical_buyer'] }],
      signals: [{ kind: 'trigger', title: 'Raised a Series A', occurredAt: new Date('2026-09-01T00:00:00Z') }],
    });
    const view = await t.run((ctx) => getAccountForScoring(ctx, out.accountId));
    expect(view).toMatchObject({
      accountId: out.accountId,
      practiceIds: [p.id],
      researchTier: null,
      researchTierSignalAt: null,
      excludedReasonKey: null,
      excludedOverride: false,
    });
    expect(view!.facts.find((f) => f.key === 'employees')).toMatchObject({
      value: 100,
      status: 'current',
      sourceChain: { personSourceId: 'src_person1', agentSourceId: 'src_agent1' },
    });
    expect(view!.people[0]).toMatchObject({ seniority: 'chief', roles: [{ key: 'technical_buyer', origin: 'stated' }] });
    expect(view!.signals[0]).toMatchObject({ kind: 'trigger', type: 'funding', sourceChain: { agentSourceId: 'src_agent1' } });
  });
});

describe('people-only edits', () => {
  it('an API-key context (no user) gets the people-only copy', async () => {
    const out = await seed();
    const apiKey = (ctx: ModuleContext): ModuleContext => ({ ...ctx, access: { sourceId: 'src_key', dataLimit: { kind: 'all' } } });
    await expect(t.run((ctx) => editAccount(apiKey(ctx), out.accountId, { employees: 5 }))).rejects.toMatchObject({
      status: 403,
      message: 'Only a person can edit this here.',
    });
    await expect(t.run((ctx) => editAccount(ctx, out.accountId, { employees: 5 }))).rejects.toMatchObject({ status: 403 });
  });

  it('editAccount pins each changed field, survives a higher-trust fact, and publishes account.updated', async () => {
    const out = await seed();
    await asPerson((ctx) => editAccount(ctx, out.accountId, { employees: 300, description: 'Edited by hand' }));
    const [pinned] = await t.run((ctx) =>
      ctx.tx.select().from(fact).where(and(eq(fact.accountId, out.accountId), eq(fact.key, 'employees'), sql`${fact.pinnedAt} is not null`)),
    );
    expect(pinned).toMatchObject({ pinnedBy: 'usr_editor', personSourceId: 'src_editor', agentSourceId: null, status: 'current', value: 300 });

    registerSourceInfoProvider({
      getTrust: async (_c, chain) => (chain.agentSourceId === 'src_high' ? 0.95 : 0.6),
      sourcesForAccount: async () => [],
    });
    await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ sourceChain: { personSourceId: 'src_p', agentSourceId: 'src_high' }, account: { employees: 900 } }), out.accountId),
    );
    const [acc] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc).toMatchObject({ employees: 300, description: 'Edited by hand' });

    const updates = await eventsOf(out.accountId, 'accounts.account.updated');
    expect(updates.some((e) => [...(e.payload.data.changedKeys as string[])].sort().join() === 'description,employees')).toBe(true);
  });

  it('editPerson pins values, sets roles as set_by_person, repicks the primary and publishes person.updated', async () => {
    const d = domain();
    const out = await seed({
      account: { name: 'People Co', domain: d },
      people: [
        { firstName: 'Ana', lastName: 'Silva', email: `ana@${d}`, title: 'Manager' },
        { firstName: 'Ben', lastName: 'Okafor', email: `ben@${d}`, title: 'Analyst' },
      ],
    });
    const [ana, ben] = out.personIds as [string, string];
    await asPerson((ctx) => editPerson(ctx, ben, { title: 'Chief Executive Officer', seniority: 'chief', roleKeys: ['economic_buyer'] }));
    const [row] = await t.run((ctx) => ctx.tx.select().from(person).where(eq(person.id, ben)));
    expect(row).toMatchObject({ title: 'Chief Executive Officer', seniority: 'chief' });
    const roles = await t.run((ctx) => ctx.tx.select().from(personRole).where(eq(personRole.personId, ben)));
    expect(roles).toEqual([expect.objectContaining({ roleKey: 'economic_buyer', origin: 'set_by_person', setBy: 'usr_editor' })]);
    const people = await t.run((ctx) => listPeople(ctx, out.accountId));
    expect(people.find((p) => p.id === ben)!.isPrimary).toBe(true);
    expect(people.find((p) => p.id === ana)!.isPrimary).toBe(false);
    const updates = await eventsOf(out.accountId, 'accounts.person.updated');
    expect(updates.at(-1)!.payload.data).toMatchObject({ personId: ben, roleKeys: ['economic_buyer'] });
    expect([...(updates.at(-1)!.payload.data.changedKeys as string[])].sort()).toEqual(['roles', 'seniority', 'title']);

    // A pinned primary wins until removed.
    await asPerson((ctx) => pinPrimary(ctx, out.accountId, ana));
    let now = await t.run((ctx) => listPeople(ctx, out.accountId));
    expect(now.find((p) => p.id === ana)!.isPrimary).toBe(true);
    expect(now.filter((p) => p.isPrimary)).toHaveLength(1);
    await asPerson((ctx) => pinPrimary(ctx, out.accountId, null));
    now = await t.run((ctx) => listPeople(ctx, out.accountId));
    expect(now.find((p) => p.id === ben)!.isPrimary).toBe(true);
    expect(now.filter((p) => p.isPrimary)).toHaveLength(1);
  });

  it('a person removes a practice through setPractices', async () => {
    await t.run((ctx) => createPractice(ctx, { name: 'Removable', slug: 'removable' }));
    const out = await seed({ practiceHint: 'removable' });
    const before = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(before[0]!.practiceIds).toHaveLength(1);
    await asPerson((ctx) => setPractices(ctx, out.accountId, [], 'person'));
    const [acc] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc!.practiceIds).toEqual([]);
  });

  it('archiveSignal hides the signal from scoring reads; includeArchived shows it again', async () => {
    const out = await seed({ signals: [{ kind: 'trigger', title: 'New CIO named', occurredAt: new Date('2026-09-02T00:00:00Z') }] });
    const sigId = out.signalIds[0]!;
    await asPerson((ctx) => archiveSignal(ctx, sigId, 'Not relevant'));
    expect(await t.run((ctx) => getSignals(ctx, out.accountId))).toEqual([]);
    expect((await t.run((ctx) => getAccountForScoring(ctx, out.accountId)))!.signals).toEqual([]);
    const shown = await t.run((ctx) => getSignals(ctx, out.accountId, { includeArchived: true }));
    expect(shown).toHaveLength(1);
    expect(shown[0]!.archivedAt).toBeInstanceOf(Date);
    expect(await t.run((ctx) => getSignals(ctx, out.accountId, { includeArchived: true, since: new Date('2026-10-01T00:00:00Z') }))).toEqual([]);
  });
});

describe('ACC-E7-S2 override', () => {
  it('AC1 needs a note, writes an audit row and publishes exclusion_changed with override true', async () => {
    const out = await seed({ account: { name: 'Blocked Co', domain: domain() } });
    await t.run((ctx) => ctx.tx.update(account).set({ excludedReasonKey: 'competitor' }).where(eq(account.id, out.accountId)));
    expect(await t.run((ctx) => checkExclusion(ctx, out.accountId))).toMatchObject({ key: 'competitor', override: false });

    await expect(asPerson((ctx) => overrideExclusion(ctx, out.accountId, '  '))).rejects.toMatchObject({
      status: 400,
      message: 'Add a note saying why.',
    });
    await asPerson((ctx) => overrideExclusion(ctx, out.accountId, 'Their CIO asked us in.'));

    const [acc] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc!.excludedOverride).toBe(true);
    expect(await t.run((ctx) => checkExclusion(ctx, out.accountId))).toMatchObject({ key: 'competitor', override: true });
    const audits = (await adminDb.execute(
      sql`select action, after from platform.audit_log where tenant_id = ${t.tenantId} and subject_id = ${out.accountId}`,
    )) as unknown as { action: string; after: { note?: string } }[];
    expect(audits).toEqual([
      expect.objectContaining({ action: 'accounts.exclusion.override', after: expect.objectContaining({ note: 'Their CIO asked us in.' }) }),
    ]);
    expect((await eventsOf(out.accountId, 'accounts.account.exclusion_changed')).at(-1)!.payload.data).toMatchObject({ override: true });

    await asPerson((ctx) => removeExclusionOverride(ctx, out.accountId));
    const [after] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(after!.excludedOverride).toBe(false);
    expect((await eventsOf(out.accountId, 'accounts.account.exclusion_changed')).at(-1)!.payload.data).toMatchObject({ override: false });
  });
});

describe('ACC-E1-S2-AC3 convert a shell', () => {
  it('keeps the replaced domain as an alias, so an arrival on the old domain matches the same account', async () => {
    const oldDomain = domain();
    const out = await seed({ account: { name: 'Rebrand Co', domain: oldDomain } });
    const newDomain = domain();
    await asPerson((ctx) => editAccount(ctx, out.accountId, { domain: newDomain }));
    const matches = await t.run((ctx) => findMatches(ctx, { name: 'Rebrand Co', domain: oldDomain }));
    expect(matches.map((m) => m.accountId)).toEqual([out.accountId]);
  });

  it('keeps the old name as an alias and gives the account a company name and domain', async () => {
    const d = domain();
    const out = await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ soleProprietor: true, people: [{ firstName: 'Sam', lastName: 'Solo', email: `sam@${d}` }] })),
    );
    expect(await t.run((ctx) => getAccount(ctx, out.accountId))).toMatchObject({ name: 'Sam Solo', isShell: true });

    await asPerson((ctx) => convertShell(ctx, out.accountId, { name: 'Solo Works LLC', domain: d }));
    const [acc] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, out.accountId)));
    expect(acc).toMatchObject({ name: 'Solo Works LLC', domain: d, isShell: false, matchName: 'solo works' });
    const aliases = await t.run((ctx) => ctx.tx.select().from(accountAlias).where(eq(accountAlias.accountId, out.accountId)));
    expect(aliases).toContainEqual(expect.objectContaining({ kind: 'name', value: 'sam solo' }));
    expect((await eventsOf(out.accountId, 'accounts.account.updated')).length).toBeGreaterThan(0);
  });
});

describe('primary contact', () => {
  it('an arrival with two people gives exactly one primary, and a later arrival does not displace a pinned one', async () => {
    const d = domain();
    const out = await seed({
      account: { name: 'Primary Co', domain: d },
      people: [
        { firstName: 'Ana', email: `ana@${d}`, title: 'Analyst' },
        { firstName: 'Ben', email: `ben@${d}`, title: 'Chief Executive Officer', seniority: 'chief' },
      ],
    });
    const [ana, ben] = out.personIds as [string, string];
    let people = await t.run((ctx) => listPeople(ctx, out.accountId));
    expect(people.filter((p) => p.isPrimary).map((p) => p.id)).toEqual([ben]);

    await asPerson((ctx) => pinPrimary(ctx, out.accountId, ana));
    await t.run((ctx) =>
      upsertFromArrival(ctx, arrival({ people: [{ firstName: 'Cy', email: `cy@${d}`, title: 'President', seniority: 'owner' }] }), out.accountId),
    );
    people = await t.run((ctx) => listPeople(ctx, out.accountId));
    expect(people.filter((p) => p.isPrimary).map((p) => p.id)).toEqual([ana]);
    const [row] = await t.run((ctx) => ctx.tx.select().from(person).where(eq(person.id, ana)));
    expect(row).toMatchObject({ primaryPinnedBy: 'usr_editor' });
    expect(row!.primaryPinnedAt).toBeInstanceOf(Date);
    const pinFacts = await t.run((ctx) => ctx.tx.select().from(fact).where(and(eq(fact.accountId, out.accountId), eq(fact.key, 'primary_person_id'))));
    expect(pinFacts).toEqual([]);

    // Pinning another person clears the first pin; null clears all.
    await asPerson((ctx) => pinPrimary(ctx, out.accountId, ben));
    expect((await t.run((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, out.accountId)))).filter((p) => p.primaryPinnedAt)).toHaveLength(1);
    await asPerson((ctx) => pinPrimary(ctx, out.accountId, null));
    expect((await t.run((ctx) => ctx.tx.select().from(person).where(eq(person.accountId, out.accountId)))).filter((p) => p.primaryPinnedAt)).toHaveLength(0);
  });
});

describe('editPerson guards', () => {
  it('refuses an archived person and maps a duplicate email to 409', async () => {
    const d = domain();
    const out = await seed({
      account: { name: 'Guard Co', domain: d },
      people: [{ firstName: 'Ana', email: `ana@${d}` }, { firstName: 'Ben', email: `ben@${d}` }, { firstName: 'Cy' }],
    });
    const [, ben, cy] = out.personIds as [string, string, string];
    await expect(asPerson((ctx) => editPerson(ctx, ben, { email: `ANA@${d}` }))).rejects.toMatchObject({
      status: 409,
      message: 'That email is already on another person at this account.',
    });
    await t.run((ctx) => ctx.tx.update(person).set({ archivedAt: new Date() }).where(eq(person.id, cy)));
    await expect(asPerson((ctx) => editPerson(ctx, cy, { title: 'CTO' }))).rejects.toMatchObject({ status: 404 });
  });
});
