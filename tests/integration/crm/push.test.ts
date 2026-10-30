import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { getAccount, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import {
  OWNER_INACTIVE,
  RETRIES_FAILED,
  TOKEN_REFUSED,
  handoffCompleted,
  handoffFailed,
  handoffNeedsDecision,
  hubspotMock,
  registerHandoffPackageProvider,
  seedMockCrm,
  syncOwners,
} from '@/modules/crm';
import { followThrough, handoff, link, mockCompany, mockNote, mockPerson, mockTask } from '@/modules/crm/db/schema';
import { mockAddDeal, setMockFailure } from '@/modules/crm/fixtures';
import { assign, assignmentCreated, bulk } from '@/modules/routing';
import { callLog } from '@/modules/integrations/db/schema';
import { addMember } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { publishTestEvent } from '../helpers/publish';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, member, resolved, routingTenant, type Tenant } from '../routing/helpers';
import { seedUser } from '../tenancy/helpers';

type ArrivalPerson = ArrivalForAccounts['people'][number];

let t: Tenant;
let seller: string;
let vijay: string;
let rahul: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  ({ vijay, rahul } = await t.run((ctx) => seedMockCrm(ctx)));
  await t.run((ctx) => syncOwners(ctx));
});
afterEach(() => registerHandoffPackageProvider(null));
afterAll(closeDbs);

const sellerOwner = () => `mock-${seller}`;

/** An account that arrived with these people and resolved, so it has a review row. */
async function account(opts: { domain?: string; people?: ArrivalPerson[] } = {}): Promise<string> {
  const arrivalId = newId('evt').replace('evt_', 'arr_');
  const { accountId } = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId,
      receivedAt: new Date(),
      sourceChain: {},
      account: { name: 'Push Co', domain: opts.domain ?? domain() },
      people: opts.people ?? [],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
  await resolved(t, accountId, { arrivalId, resolution: 'created' });
  return accountId;
}

/** A company already in the mock CRM at this domain. */
const crmCompany = (d: string, over: { ownerExternalId?: string | null; properties?: Record<string, string>; description?: string } = {}) =>
  t.run((ctx) =>
    hubspotMock(ctx).upsertCompany({
      domain: d,
      name: d,
      description: over.description ?? null,
      ownerExternalId: over.ownerExternalId ?? null,
      replaceableOwner: true,
      properties: over.properties ?? {},
    }),
  );

const handoffsOf = (accountId: string) => t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, accountId)));
const companiesAt = (d: string) => t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, d)));
const notesOf = (companyId: string) => t.run((ctx) => ctx.tx.select().from(mockNote).where(eq(mockNote.companyExternalId, companyId)));
const tasksOf = (companyId: string) => t.run((ctx) => ctx.tx.select().from(mockTask).where(eq(mockTask.companyExternalId, companyId)));
const peopleOf = (companyId: string) =>
  t.run((ctx) => ctx.tx.select().from(mockPerson).where(eq(mockPerson.companyExternalId, companyId)).orderBy(mockPerson.createdAt));
const events = async (type: string, accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === type && e.data.accountId === accountId);
const domainOf = async (accountId: string) => (await t.run((ctx) => getAccount(ctx, accountId)))!.domain!;

/** Runs the outbox until the push job stops failing, at most `times` runs. Returns how many runs threw. */
async function runThroughFailures(times: number): Promise<number> {
  let failed = 0;
  for (let i = 0; i < times; i++) {
    try {
      await runOutbox(t.tenantId);
      return failed;
    } catch {
      failed++;
    }
  }
  return failed;
}

const person = (i: number, extra: Partial<ArrivalPerson> = {}): ArrivalPerson => ({
  firstName: `Pat${i}`,
  lastName: 'Lee',
  title: 'VP Engineering',
  email: `pat${i}.${newId('acc').slice(-6).toLowerCase()}@push.example`,
  ...extra,
});

describe('handoff push on assignment (CRM-E3-S1)', () => {
  it('pushes the company, people (primary first, at most 10), one note and four tasks, all linked, within 10 seconds (AC2)', async () => {
    const a = await account({ people: Array.from({ length: 12 }, (_, i) => person(i)) });
    const started = Date.now();
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, notes: 'Call the CIO' }));
    await runOutbox(t.tenantId);
    expect(Date.now() - started).toBeLessThan(10_000);

    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'completed', attempts: 1, ownershipAction: 'assign', ownerExternalId: sellerOwner(), assignmentId: made.id, sellerUserId: seller });
    const [co] = await companiesAt(await domainOf(a));
    expect(co!.ownerExternalId).toBe(sellerOwner());
    expect(h!.companyExternalId).toBe(co!.externalId);

    const people = await peopleOf(co!.externalId);
    expect(people).toHaveLength(10);
    const view = (await t.run((ctx) => getAccount(ctx, a)))!;
    const primary = view.people.find((p) => p.isPrimary)!;
    expect(people[0]!.email).toBe(primary.email);
    expect(people.every((p) => p.ownerExternalId === sellerOwner())).toBe(true);

    const notes = await notesOf(co!.externalId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.html).toContain('Call the CIO');
    expect(notes[0]!.html).toContain(`/accounts/${a}`);
    const tasks = await tasksOf(co!.externalId);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((x) => x.ownerExternalId === sellerOwner())).toBe(true);

    const links = await t.run((ctx) => ctx.tx.select().from(link));
    const ext = new Set(links.map((l) => l.externalId));
    for (const id of [co!.externalId, ...people.map((p) => p.externalId), notes[0]!.externalId, ...tasks.map((x) => x.externalId)]) expect(ext.has(id)).toBe(true);
    const taskKeys = links.filter((l) => l.scoutType === 'task' && l.scoutId.startsWith(made.id)).map((l) => l.scoutId).sort();
    expect(taskKeys).toEqual([`${made.id}:first_touch`, `${made.id}:follow_up:14`, `${made.id}:follow_up:3`, `${made.id}:follow_up:7`]);
    expect(links.find((l) => l.scoutType === 'note' && l.scoutId === a)!.fingerprint).toBe(notes[0]!.fingerprint);

    const [done] = await events(handoffCompleted.type, a);
    expect(done!.data).toMatchObject({ handoffId: h!.id, assignmentId: made.id, companyExternalId: co!.externalId, taskCount: 4, companyLifecycle: 'none', ownershipAction: 'assign' });
    expect(typeof done!.data.observedAt).toBe('string');
    const [ft] = await t.run((ctx) => ctx.tx.select().from(followThrough).where(eq(followThrough.handoffId, h!.id)));
    expect(ft!.baseline).toMatchObject({ emails: 0, calls: 0, meetings: 0 });
  });

  it('the event delivered twice gives one handoff (AC1)', async () => {
    const a = await account();
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await publishTestEvent(t.tenantId, assignmentCreated, {
      assignmentId: made.id,
      accountId: a,
      sellerUserId: seller,
      assignedBy: t.actor.id,
      templateId: null,
      offerId: null,
      notes: null,
      ownershipDecision: 'assign',
      previousAssignmentId: null,
      bulkId: null,
    });
    await runOutbox(t.tenantId);
    expect(await handoffsOf(a)).toHaveLength(1);
    expect(await events(handoffCompleted.type, a)).toHaveLength(1);
  });

  it('429 then 500 on upsertTask retries, counts 3 attempts and still gives one company, note and set of tasks (Review Focus 2)', async () => {
    const a = await account({ people: [person(1), person(2)] });
    await t.run((ctx) => setMockFailure(ctx, 'upsertTask', '429', 1));
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    expect(await runThroughFailures(1)).toBe(1);
    await t.run((ctx) => setMockFailure(ctx, 'upsertTask', '500', 1));
    expect(await runThroughFailures(3)).toBe(1);

    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'completed', attempts: 3 });
    const cos = await companiesAt(await domainOf(a));
    expect(cos).toHaveLength(1);
    expect(await peopleOf(cos[0]!.externalId)).toHaveLength(2);
    expect(await notesOf(cos[0]!.externalId)).toHaveLength(1);
    expect(await tasksOf(cos[0]!.externalId)).toHaveLength(4);
  });

  it('the sixth failed run marks the handoff failed with the plain reason and publishes crm.handoff.failed', async () => {
    const a = await account();
    await t.run((ctx) => setMockFailure(ctx, 'upsertCompany', '500', 6));
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    expect(await runThroughFailures(6)).toBe(5);
    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'failed', attempts: 6, lastError: 'HubSpot was busy and every retry failed.' });
    const [failed] = await events(handoffFailed.type, a);
    expect(failed!.data).toMatchObject({ handoffId: h!.id, attempt: 6, reason: 'HubSpot was busy and every retry failed.' });
  });

  it('a seller with no owner id fails at once and is not retried (AC4)', async () => {
    const u = await seedUser();
    await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller' }));
    const a = await account();
    await publishTestEvent(t.tenantId, assignmentCreated, {
      assignmentId: newId('asg'),
      accountId: a,
      sellerUserId: u.id,
      assignedBy: t.actor.id,
      templateId: null,
      offerId: null,
      notes: null,
      ownershipDecision: 'assign',
      previousAssignmentId: null,
      bulkId: null,
    });
    await runOutbox(t.tenantId);
    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'failed', attempts: 1, lastError: "This seller isn't linked to a CRM owner" });
    expect((await events(handoffFailed.type, a))[0]!.data).toMatchObject({ retryable: false, reason: "This seller isn't linked to a CRM owner" });
    expect(await companiesAt(await domainOf(a))).toHaveLength(0);
  });

  it('a stop found at push time gives needs_decision and writes nothing (AC5)', async () => {
    const d = domain();
    const co = await crmCompany(d, { ownerExternalId: vijay });
    const a = await account({ domain: d });
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: co.externalId, name: 'New deal' }));
    await runOutbox(t.tenantId);
    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'needs_decision', decisionReason: 'open_deal' });
    expect((await events(handoffNeedsDecision.type, a))[0]!.data).toMatchObject({ reason: 'open_deal', currentOwnerName: 'Vijay Kumar' });
    expect((await companiesAt(d))[0]!.ownerExternalId).toBe(vijay);
    expect(await notesOf(co.externalId)).toHaveLength(0);
  });

  it('keep pushes the context without changing the owner (CRM-E3-S6-AC2)', async () => {
    const d = domain();
    const co = await crmCompany(d, { ownerExternalId: vijay });
    await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: co.externalId, name: 'Open deal' }));
    const a = await account({ domain: d, people: [person(1)] });
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller, ownershipDecision: 'keep' }));
    await runOutbox(t.tenantId);
    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'completed', ownershipAction: 'keep', takenFromOwner: null });
    expect((await companiesAt(d))[0]!.ownerExternalId).toBe(vijay);
    expect(await notesOf(co.externalId)).toHaveLength(1);
    expect(await tasksOf(co.externalId)).toHaveLength(4);
    expect((await events(handoffCompleted.type, a))[0]!.data).toMatchObject({ ownershipAction: 'keep', companyLifecycle: 'open_deal' });
  });

  it('an empty Scout value never blanks a CRM company field (CRM-E3-S3-AC3)', async () => {
    await t.run((ctx) =>
      hubspotMock(ctx).setUpProperties({
        groupName: 'scout_buyer_signals',
        properties: [
          { name: 'taazaa_why_now', label: 'Why now', type: 'string' },
          { name: 'taazaa_tier', label: 'Tier', type: 'string' },
        ],
      }),
    );
    const d = domain();
    const co = await crmCompany(d, { properties: { taazaa_why_now: 'A rep wrote this' }, description: 'Rep description' });
    registerHandoffPackageProvider({
      package: async () => ({ sections: [], properties: { why_now: '', tier: 'act_now' }, firstTouch: null, followUps: [], planSteps: [] }),
    });
    const a = await account({ domain: d });
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await runOutbox(t.tenantId);
    const [after] = await t.run((ctx) => ctx.tx.select().from(mockCompany).where(and(eq(mockCompany.externalId, co.externalId))));
    expect(after!.properties).toMatchObject({ taazaa_why_now: 'A rep wrote this', taazaa_tier: 'Act now' });
    expect(after!.description).toBe('Rep description');
  });

  it('a bulk assign of two accounts shares one bulkId and one handoff batch (Ruling 8)', async () => {
    const accounts = [await account(), await account()];
    await asPerson(t, (ctx) => bulk(ctx, accounts, { kind: 'assign', sellerUserId: seller }));
    const ids = await Promise.all(accounts.map(async (a) => (await events(assignmentCreated.type, a))[0]!.data.bulkId));
    expect(ids[0]).toMatch(/^blk_/);
    expect(ids[1]).toBe(ids[0]);
    await runOutbox(t.tenantId);
    const hs = (await Promise.all(accounts.map(handoffsOf))).flat();
    expect(hs.every((h) => h.status === 'completed')).toBe(true);
    expect(hs[0]!.handoffBatchId).toBeTruthy();
    expect(hs[1]!.handoffBatchId).toBe(hs[0]!.handoffBatchId);
    const single = await account();
    await asPerson(t, (ctx) => assign(ctx, single, { sellerUserId: seller }));
    await runOutbox(t.tenantId);
    expect((await events(assignmentCreated.type, single))[0]!.data.bulkId).toBeNull();
    expect((await handoffsOf(single))[0]!.handoffBatchId).not.toBe(hs[0]!.handoffBatchId);
  });
});

/** Publishes `routing.assignment.created` and delivers it, stopping once the handoff is queued (its push not run yet). */
async function queued(accountId: string, sellerUserId = seller): Promise<void> {
  await publishTestEvent(t.tenantId, assignmentCreated, {
    assignmentId: newId('asg'),
    accountId,
    sellerUserId,
    assignedBy: t.actor.id,
    templateId: null,
    offerId: null,
    notes: null,
    ownershipDecision: 'assign',
    previousAssignmentId: null,
    bulkId: null,
  });
  await runOutbox(t.tenantId, { until: async () => (await handoffsOf(accountId)).length > 0 });
}
const setAttempts = (accountId: string, attempts: number) => t.run((ctx) => ctx.tx.update(handoff).set({ attempts }).where(eq(handoff.accountId, accountId)));
const callCount = async () => (await adminDb.select({ id: callLog.id }).from(callLog).where(eq(callLog.tenantId, t.tenantId))).length;

describe('giving up and failing for good (Ruling 4, fix round 1)', () => {
  it('a run that finds six attempts already used marks the handoff failed with no CRM call', async () => {
    const a = await account();
    await queued(a);
    await setAttempts(a, 6); // six earlier runs died without saying so
    const calls = await callCount();
    await runOutbox(t.tenantId);
    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'failed', attempts: 6, lastError: RETRIES_FAILED });
    expect((await events(handoffFailed.type, a))[0]!.data).toMatchObject({ attempt: 6, reason: RETRIES_FAILED });
    expect(await callCount()).toBe(calls);
    expect(await companiesAt(await domainOf(a))).toHaveLength(0);
  });

  it('a final run whose transaction a database error aborted still leaves the handoff failed', async () => {
    // Deterministic: the package provider raises a serialisation failure (SQLSTATE 40001) inside the push
    // transaction, which aborts it; on the sixth attempt that retryable error must end as failed.
    registerHandoffPackageProvider({
      package: async (ctx) => {
        await ctx.tx.execute(sql`do $$ begin raise exception 'forced' using errcode = '40001'; end $$`);
        return null;
      },
    });
    const a = await account();
    await queued(a);
    await setAttempts(a, 5);
    await runOutbox(t.tenantId).catch(() => undefined); // the commit of the aborted transaction may throw
    const [h] = await handoffsOf(a);
    expect(h).toMatchObject({ status: 'failed', attempts: 6, lastError: RETRIES_FAILED });
    expect(await events(handoffFailed.type, a)).toHaveLength(1);
    registerHandoffPackageProvider(null);
    await runOutbox(t.tenantId); // a redelivery finds it finished and does nothing
    expect((await handoffsOf(a))[0]!.status).toBe('failed');
  });

  it('a 401 fails at once with the token sentence; a 403 names the permission', async () => {
    const a = await account();
    await t.run((ctx) => setMockFailure(ctx, 'upsertCompany', '401', 1));
    await queued(a);
    await runOutbox(t.tenantId);
    expect((await handoffsOf(a))[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: TOKEN_REFUSED });
    expect((await events(handoffFailed.type, a))[0]!.data).toMatchObject({ retryable: false, reason: TOKEN_REFUSED });

    const b = await account();
    await t.run((ctx) => setMockFailure(ctx, 'upsertCompany', '403', 1));
    await queued(b);
    await runOutbox(t.tenantId);
    expect((await handoffsOf(b))[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: 'HubSpot needs another permission: crm.objects.companies.write.' });
  });

  it("a seller whose HubSpot owner is inactive in the roster fails at once", async () => {
    const u = await seedUser();
    await t.run((ctx) => addMember(ctx, { email: u.email, role: 'seller', crmOwnerIds: { hubspot: rahul } }));
    const a = await account();
    await queued(a, u.id);
    await runOutbox(t.tenantId);
    expect((await handoffsOf(a))[0]).toMatchObject({ status: 'failed', attempts: 1, lastError: OWNER_INACTIVE });
    expect(await companiesAt(await domainOf(a))).toHaveLength(0);
  });
});
