import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  findMatches,
  getAccount,
  getSignals,
  mergeAccounts,
  registerMergeGuard,
  upsertFromArrival,
  type ArrivalForAccounts,
} from '@/modules/accounts';
import { account, accountAlias, accountSummary, person, personAlias } from '@/modules/accounts/db/schema';
import type { ModuleContext } from '@/platform/context';
import { adminDb } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { freshTenant } from '../offers/helpers';

let t: Awaited<ReturnType<typeof freshTenant>>;

beforeAll(async () => {
  t = await freshTenant();
  await runOutbox(t.tenantId);
});

afterEach(() => registerMergeGuard(null));

const domain = () => `${newId('acc').slice(-10).toLowerCase()}.example.com`;
const personAccess = { userId: 'usr_leader', sourceId: 'src_leader', dataLimit: { kind: 'all' as const } };
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

const seed = (over: Partial<ArrivalForAccounts>) => t.run((ctx) => upsertFromArrival(ctx, arrival(over)));

const eventsOf = async (type: string, key: 'survivorId' | 'accountId', id: string) =>
  (await adminDb.execute(
    sql`select payload from platform.outbox where tenant_id = ${t.tenantId} and payload->>'type' = ${type}
        and payload->'data'->>${key} = ${id}`,
  )) as unknown as { payload: { data: Record<string, unknown> } }[];

describe('mergeAccounts', () => {
  it('moves everything to the survivor, collapses duplicates and archives the merged account', async () => {
    const dA = domain();
    const dB = domain();
    const a = await seed({
      sourceChain: { personSourceId: 'src_a' },
      account: { name: 'Merge Alpha', domain: dA },
      people: [{ firstName: 'Ana', lastName: 'Silva', email: `ana@${dA}`, title: 'CIO' }],
      signals: [{ kind: 'trigger', title: 'Raised a Series B', occurredAt: new Date('2026-09-01T00:00:00Z') }],
    });
    const b = await seed({
      sourceChain: { personSourceId: 'src_b' },
      account: { name: 'Merge Beta', domain: dB, employees: 40 },
      externalIds: [{ system: 'hubspot', id: 'hs-1' }],
      people: [
        { firstName: 'Ana', lastName: 'Silva', email: `ana@${dA}`, title: 'Chief Information Officer' },
        { firstName: 'Bo', lastName: 'Lin', email: `bo@${dB}` },
      ],
      signals: [
        { kind: 'trigger', title: 'Raised a Series B', occurredAt: new Date('2026-09-01T00:00:00Z') },
        { kind: 'trigger', title: 'New office in Lisbon', occurredAt: new Date('2026-09-05T00:00:00Z') },
      ],
    });

    await asPerson((ctx) => mergeAccounts(ctx, a.accountId, b.accountId));

    // ACC-E5-S1-AC2: the merged domain now matches the survivor.
    const matches = await t.run((ctx) => findMatches(ctx, { domain: dB }));
    expect(matches.map((m) => m.accountId)).toEqual([a.accountId]);
    expect(await t.run((ctx) => findMatches(ctx, { externalIds: [{ system: 'hubspot', id: 'hs-1' }] }))).toMatchObject([
      { accountId: a.accountId },
    ]);

    // ACC-E5-S1-AC3: the merged id returns the survivor.
    const view = await t.run((ctx) => getAccount(ctx, b.accountId));
    expect(view).toMatchObject({ id: a.accountId, mergedInto: a.accountId, name: 'Merge Alpha', domain: dA });
    expect(view!.aliases).toEqual(
      expect.arrayContaining([
        { kind: 'domain', value: dB, system: '' },
        { kind: 'name', value: 'merge beta', system: '' },
        { kind: 'merged_id', value: b.accountId, system: '' },
      ]),
    );

    // People: Ana collapses, Bo moves. The duplicate becomes a merged_id alias of the survivor's Ana.
    expect(view!.people.map((p) => p.firstName).sort()).toEqual(['Ana', 'Bo']);
    const [dupAlias] = await t.run((ctx) => ctx.tx.select().from(personAlias).where(eq(personAlias.kind, 'merged_id')));
    expect(dupAlias!.personId).toBe(a.personIds[0]);
    expect(dupAlias!.value).toBe(b.personIds[0]);
    const [dup] = await t.run((ctx) => ctx.tx.select().from(person).where(eq(person.id, b.personIds[0]!)));
    expect(dup!.archivedAt).not.toBeNull();
    expect(view!.people.filter((p) => p.isPrimary)).toHaveLength(1);

    // Signals: the same title and day is stored once as live; the other moves.
    const signals = await t.run((ctx) => getSignals(ctx, a.accountId));
    expect(signals.map((s) => s.title).sort()).toEqual(['New office in Lisbon', 'Raised a Series B']);

    // Facts followed: the merged account's employees is now the survivor's.
    expect(view!.employees).toBe(40);

    // The merged account is archived and its domain is free of the unique index.
    const [merged] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, b.accountId)));
    expect(merged!.archivedAt).not.toBeNull();
    const live = await t.run((ctx) =>
      ctx.tx.select({ id: account.id }).from(account).where(and(eq(account.tenantId, ctx.tenantId), isNull(account.archivedAt), eq(account.domain, dB))),
    );
    expect(live).toEqual([]);

    // Events and audit.
    const merges = await eventsOf('accounts.account.merged', 'survivorId', a.accountId);
    expect(merges[0]!.payload.data).toMatchObject({ survivorId: a.accountId, mergedId: b.accountId, mergedBy: 'usr_leader' });
    const archived = await eventsOf('accounts.account.archived', 'accountId', b.accountId);
    expect(archived[0]!.payload.data).toMatchObject({ accountId: b.accountId, reason: 'merged' });
    const audits = (await adminDb.execute(
      sql`select before, after from platform.audit_log where tenant_id = ${t.tenantId} and action = 'accounts.account.merge' and subject_id = ${a.accountId}`,
    )) as unknown as { before: { mergedId: string }; after: { survivorId: string } }[];
    expect(audits).toHaveLength(1);
    expect(audits[0]!.before.mergedId).toBe(b.accountId);
    expect(audits[0]!.after.survivorId).toBe(a.accountId);
  });

  it("the survivor's summary source_ids is the union of both accounts'", async () => {
    const a = await seed({ sourceChain: { personSourceId: 'src_u1' }, account: { name: 'Union One', domain: domain() } });
    const b = await seed({ sourceChain: { personSourceId: 'src_u2', agentSourceId: 'src_u3' }, account: { name: 'Union Two', domain: domain() } });
    await asPerson((ctx) => mergeAccounts(ctx, a.accountId, b.accountId));
    const [summary] = await t.run((ctx) => ctx.tx.select().from(accountSummary).where(eq(accountSummary.accountId, a.accountId)));
    expect(summary!.sourceIds).toEqual(['src_u1', 'src_u2', 'src_u3']);
  });

  it('a guard that refuses fails the merge with its copy and nothing changes', async () => {
    const a = await seed({ account: { name: 'Guard One', domain: domain() } });
    const b = await seed({ account: { name: 'Guard Two', domain: domain() } });
    registerMergeGuard({ check: async () => ({ allowed: false, reason: 'These are different companies in HubSpot. Merge them there first.' }) });
    await expect(asPerson((ctx) => mergeAccounts(ctx, a.accountId, b.accountId))).rejects.toMatchObject({
      status: 409,
      message: 'These are different companies in HubSpot. Merge them there first.',
    });
    const [merged] = await t.run((ctx) => ctx.tx.select().from(account).where(eq(account.id, b.accountId)));
    expect(merged!.archivedAt).toBeNull();
    const aliases = await t.run((ctx) => ctx.tx.select().from(accountAlias).where(eq(accountAlias.kind, 'merged_id')));
    expect(aliases.some((x) => x.value === b.accountId)).toBe(false);
  });

  it('an API-key context gets 403', async () => {
    const a = await seed({ account: { name: 'Key One', domain: domain() } });
    const b = await seed({ account: { name: 'Key Two', domain: domain() } });
    const apiKey = (ctx: ModuleContext): ModuleContext => ({ ...ctx, access: { sourceId: 'src_key', dataLimit: { kind: 'all' } } });
    await expect(t.run((ctx) => mergeAccounts(apiKey(ctx), a.accountId, b.accountId))).rejects.toMatchObject({
      status: 403,
      message: 'Only a person can merge accounts.',
    });
    await expect(t.run((ctx) => mergeAccounts(ctx, a.accountId, b.accountId))).rejects.toMatchObject({ status: 403 });
  });

  it('refuses itself, a missing account and an archived account', async () => {
    const a = await seed({ account: { name: 'Edge One', domain: domain() } });
    const b = await seed({ account: { name: 'Edge Two', domain: domain() } });
    await expect(asPerson((ctx) => mergeAccounts(ctx, a.accountId, a.accountId))).rejects.toMatchObject({
      status: 409,
      message: 'Choose two different accounts.',
    });
    await expect(asPerson((ctx) => mergeAccounts(ctx, a.accountId, 'acc_missing'))).rejects.toMatchObject({
      status: 404,
      message: 'That account was not found.',
    });
    await asPerson((ctx) => mergeAccounts(ctx, a.accountId, b.accountId));
    await expect(asPerson((ctx) => mergeAccounts(ctx, a.accountId, b.accountId))).rejects.toMatchObject({
      status: 409,
      message: 'An archived account cannot be merged.',
    });
  });
});
