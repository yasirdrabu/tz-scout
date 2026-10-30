import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { getAccount, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { handoffCancelled, hubspotMock, runPush, runUndo, seedMockCrm, syncOwners } from '@/modules/crm';
import { handoff, mockCompany, mockNote, mockPerson, mockTask } from '@/modules/crm/db/schema';
import { mockAddDeal, mockCompleteTask } from '@/modules/crm/fixtures';
import { callLog } from '@/modules/integrations/db/schema';
import { assign, decline, withdraw } from '@/modules/routing';
import { addMember, members, tenantTimezone } from '@/modules/tenancy';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, member, resolved, routingTenant, type Tenant } from '../routing/helpers';
import { seedUser } from '../tenancy/helpers';

type ArrivalPerson = ArrivalForAccounts['people'][number];

let t: Tenant;
let ash: string;
let mike: string;
let leader: string;
let vijay: string;

beforeAll(async () => {
  t = await routingTenant();
  ash = await member(t, 'seller');
  mike = await member(t, 'seller');
  const u = await seedUser();
  await t.run((ctx) => addMember(ctx, { email: u.email, role: 'leader', crmOwnerIds: { hubspot: `mock-${u.id}` } }));
  leader = u.id;
  ({ vijay } = await t.run((ctx) => seedMockCrm(ctx)));
  await t.run((ctx) => syncOwners(ctx));
});
afterAll(closeDbs);

const ownerOf = (userId: string) => `mock-${userId}`;
const nameOf = async (userId: string) => (await t.run((ctx) => members(ctx))).find((m) => m.userId === userId)!.name;
const today = async () => {
  const timeZone = await t.run((ctx) => tenantTimezone(ctx));
  return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone });
};

async function account(opts: { domain?: string; people?: ArrivalPerson[] } = {}): Promise<string> {
  const arrivalId = newId('evt').replace('evt_', 'arr_');
  const { accountId } = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId,
      receivedAt: new Date(),
      sourceChain: {},
      account: { name: 'Undo Co', domain: opts.domain ?? domain() },
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

const person = (i: number): ArrivalPerson => ({
  firstName: `Sam${i}`,
  lastName: 'Undo',
  title: 'CTO',
  email: `sam${i}.${newId('acc').slice(-6).toLowerCase()}@undo.example`,
});

const crmCompany = (d: string, ownerExternalId: string) =>
  t.run((ctx) => hubspotMock(ctx).upsertCompany({ domain: d, name: d, ownerExternalId, replaceableOwner: true, properties: {} }));

const handoffOf = async (assignmentId: string) => (await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.assignmentId, assignmentId))))[0]!;
const companyAt = async (d: string) => (await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, d))))[0]!;
const notesOf = (companyId: string) => t.run((ctx) => ctx.tx.select().from(mockNote).where(eq(mockNote.companyExternalId, companyId)).orderBy(mockNote.externalId));
const tasksOf = (companyId: string) => t.run((ctx) => ctx.tx.select().from(mockTask).where(eq(mockTask.companyExternalId, companyId)));
const peopleOf = (companyId: string) => t.run((ctx) => ctx.tx.select().from(mockPerson).where(eq(mockPerson.companyExternalId, companyId)));
const tasksById = async (ids: string[]) => (await t.run((ctx) => ctx.tx.select().from(mockTask))).filter((x) => ids.includes(x.externalId));
const events = async (type: string, accountId: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === type && e.data.accountId === accountId);
const domainOf = async (accountId: string) => (await t.run((ctx) => getAccount(ctx, accountId)))!.domain!;
const callCount = async () => (await adminDb.select({ id: callLog.id }).from(callLog).where(eq(callLog.tenantId, t.tenantId))).length;

/** Assigns as the leader and runs the push to the end. */
async function pushed(opts: { domain?: string; people?: ArrivalPerson[]; seller?: string; ownershipDecision?: 'assign' | 'keep' } = {}) {
  const a = await account(opts);
  const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: opts.seller ?? ash, ownershipDecision: opts.ownershipDecision }), { userId: leader });
  await runOutbox(t.tenantId);
  const h = await handoffOf(made.id);
  expect(h.status).toBe('completed');
  return { a, asg: made.id, h, d: await domainOf(a) };
}

const declineAs = (seller: string, assignmentId: string) =>
  asPerson(t, (ctx) => decline(ctx, assignmentId, { reasonKey: 'not_my_territory' }), { userId: seller });

describe('undo on decline (CRM-E3-S7)', () => {
  it('closes the four tasks with the reason and returns the company and people to the previous owner (AC1)', async () => {
    const d = domain();
    await crmCompany(d, vijay);
    const { a, asg, h } = await pushed({ domain: d, people: [person(1), person(2)] });
    expect(h.takenFromOwner).toBe(vijay);
    const co = await companyAt(d);
    expect(co.ownerExternalId).toBe(ownerOf(ash));

    await declineAs(ash, asg);
    await runOutbox(t.tenantId);

    const tasks = await tasksOf(co.externalId);
    expect(tasks).toHaveLength(4);
    expect(tasks.every((x) => x.status === 'completed' && x.body!.includes('Declined in Scout: Not my territory'))).toBe(true);
    expect((await companyAt(d)).ownerExternalId).toBe(vijay);
    const people = await peopleOf(co.externalId);
    expect(people).toHaveLength(2);
    expect(people.every((p) => p.ownerExternalId === vijay)).toBe(true);
    const after = await handoffOf(asg);
    expect(after.status).toBe('completed');
    expect(after.undone).toMatchObject({ ownerReturnedTo: vijay, tasksLeftDone: [] });
    expect([...after.undone!.tasksClosed].sort()).toEqual(tasks.map((x) => x.externalId).sort());
    expect(await events(handoffCancelled.type, a)).toHaveLength(0);
  });

  it('gives inactive-owner.example back to the assigner, not the inactive previous owner', async () => {
    const { asg, h } = await pushed({ domain: 'inactive-owner.example' });
    expect(h.takenFromOwner).not.toBeNull();
    await declineAs(ash, asg);
    await runOutbox(t.tenantId);
    expect((await companyAt('inactive-owner.example')).ownerExternalId).toBe(ownerOf(leader));
    expect((await handoffOf(asg)).undone).toMatchObject({ ownerReturnedTo: ownerOf(leader) });
  });

  it('a keep handoff changes no owner', async () => {
    const d = domain();
    const co = await crmCompany(d, vijay);
    await t.run((ctx) => mockAddDeal(ctx, { companyExternalId: co.externalId, name: 'Open deal' }));
    const { asg } = await pushed({ domain: d, people: [person(3)], ownershipDecision: 'keep' });
    await declineAs(ash, asg);
    await runOutbox(t.tenantId);
    expect((await companyAt(d)).ownerExternalId).toBe(vijay);
    expect((await tasksOf(co.externalId)).every((x) => x.status === 'completed')).toBe(true);
    expect((await handoffOf(asg)).undone).toMatchObject({ ownerReturnedTo: null });
  });

  it('a task the rep completed stays completed and is listed in tasksLeftDone (AC3)', async () => {
    const { asg, d } = await pushed();
    const co = await companyAt(d);
    const before = await tasksOf(co.externalId);
    const done = before[0]!;
    await t.run((ctx) => mockCompleteTask(ctx, done.externalId));
    await declineAs(ash, asg);
    await runOutbox(t.tenantId);
    const undone = (await handoffOf(asg)).undone!;
    expect(undone.tasksLeftDone).toEqual([done.externalId]);
    expect(undone.tasksClosed).toHaveLength(3);
    const [kept] = await tasksById([done.externalId]);
    expect(kept!.body).toBe(done.body);
  });

  it('adds one short note and leaves the context note as it was (AC2)', async () => {
    const { asg, d } = await pushed();
    const co = await companyAt(d);
    const [context] = await notesOf(co.externalId);
    await declineAs(ash, asg);
    await runOutbox(t.tenantId);
    const notes = await notesOf(co.externalId);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.externalId === context!.externalId)!.html).toBe(context!.html);
    const added = notes.find((n) => n.externalId !== context!.externalId)!;
    expect(added.html).toContain(`Returned by ${await nameOf(ash)} on ${await today()}: Not my territory`);
    expect((await handoffOf(asg)).undone).toMatchObject({ noteExternalId: added.externalId });
  });

  it('running the undo twice changes nothing', async () => {
    const { asg, d, h } = await pushed();
    await declineAs(ash, asg);
    await runOutbox(t.tenantId);
    const co = await companyAt(d);
    const first = await handoffOf(asg);
    const calls = await callCount();
    await t.run((ctx) => runUndo(ctx, h.id, new Date(), { kind: 'declined', reasonLabel: 'Not my territory', by: ash }));
    expect(await callCount()).toBe(calls);
    expect((await handoffOf(asg)).undone).toEqual(first.undone);
    expect(await notesOf(co.externalId)).toHaveLength(2);
  });
});

describe('a decline during or before the push (Review Focus 1, CRM-E3-S7-AC4)', () => {
  const MOCK_LOCK = () => `crm-mock:${t.tenantId}`;
  /** True once a session waits on the mock CRM's id lock (the push, inside its person write). */
  const pushWaitsOnMock = async () => {
    const rows = await adminDb.execute(sql`
      select 1 from pg_locks
      where locktype = 'advisory' and not granted and objsubid = 1
        and objid::bigint = (hashtext(${MOCK_LOCK()})::bigint & 4294967295)`);
    return rows.length > 0;
  };
  const until = async (check: () => Promise<boolean>) => {
    for (let i = 0; i < 200; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timed out waiting');
  };

  it('a decline while the push is held after its company write stops the push with cancelled; the undo returns what was written', async () => {
    // Deterministic hold: the test holds the mock CRM's id lock, so the push writes the (existing) company,
    // then waits inside its first person write, which must create a contact. The decline lands then.
    const d = domain();
    await crmCompany(d, vijay);
    const a = await account({ domain: d, people: [person(4)] });
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: ash }), { userId: leader });
    await runOutbox(t.tenantId, { until: async () => !!(await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, a))))[0] });
    // The test runs the push itself; the queued job is marked delivered so the outbox doesn't run it alongside.
    await adminDb.update(outbox).set({ sentAt: new Date() }).where(and(eq(outbox.tenantId, t.tenantId), isNull(outbox.sentAt), sql`${outbox.payload}->>'type' = 'jobs.crm.handoff.push'`));
    const h = await handoffOf(made.id);

    let release!: () => void;
    let held!: () => void;
    const isHeld = new Promise<void>((r) => (held = r));
    const hold = adminDb.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MOCK_LOCK()}))`);
      held();
      await new Promise<void>((r) => (release = r));
    });
    await isHeld;
    const push = t.run((ctx) => runPush(ctx, h.id));
    let delivered: Promise<void> = Promise.resolve();
    try {
      await until(pushWaitsOnMock);
      expect((await companyAt(d)).ownerExternalId).toBe(ownerOf(ash)); // the company write is done
      await declineAs(ash, made.id);
      delivered = runOutbox(t.tenantId); // the undo job waits for the push's account lock
      await until(async () => !!(await handoffOf(made.id)).cancelRequestedAt);
    } finally {
      release();
      await hold;
      await push;
      await delivered;
    }

    const after = await handoffOf(made.id);
    expect(after.status).toBe('cancelled');
    expect(await events(handoffCancelled.type, a)).toHaveLength(1);
    const co = await companyAt(d);
    expect(co.ownerExternalId).toBe(vijay);
    const people = await peopleOf(co.externalId);
    expect(people).toHaveLength(1); // the write in flight finished
    expect(people[0]!.ownerExternalId).toBe(vijay);
    expect(await tasksOf(co.externalId)).toHaveLength(0);
    const notes = await notesOf(co.externalId);
    expect(notes).toHaveLength(1); // the short note only: the context note was never written
    expect(notes[0]!.html).toContain('Returned by');
    expect(after.undone).toMatchObject({ tasksClosed: [], tasksLeftDone: [], ownerReturnedTo: vijay });
  });

  it('a decline before the job runs gives cancelled with no CRM writes', async () => {
    const a = await account();
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: ash }), { userId: leader });
    await runOutbox(t.tenantId, { until: async () => !!(await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, a))))[0] });
    expect((await handoffOf(made.id)).status).toBe('queued');
    const calls = await callCount();
    // The push job is held back so the decline is delivered first, then released: it must find nothing to do.
    const pushJob = and(eq(outbox.tenantId, t.tenantId), isNull(outbox.sentAt), sql`${outbox.payload}->>'type' = 'jobs.crm.handoff.push'`);
    const [job] = await adminDb.update(outbox).set({ sentAt: new Date() }).where(pushJob).returning({ seq: outbox.seq });
    await declineAs(ash, made.id);
    await runOutbox(t.tenantId);
    expect((await handoffOf(made.id)).status).toBe('cancelled');
    await adminDb.update(outbox).set({ sentAt: null }).where(eq(outbox.seq, job!.seq));
    await runOutbox(t.tenantId);
    expect((await handoffOf(made.id)).status).toBe('cancelled');
    expect(await events(handoffCancelled.type, a)).toHaveLength(1);
    expect(await callCount()).toBe(calls);
    const d = await domainOf(a);
    expect(await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, d)))).toHaveLength(0);
  });
});

describe('a reassign (withdrawn with replacedBy)', () => {
  it('leaves the company with Mike and his four tasks open, and closes Ash\'s four', async () => {
    const { a, asg, d } = await pushed({ people: [person(5)] });
    await asPerson(t, (ctx) => withdraw(ctx, asg, { reassignTo: mike }), { userId: leader });
    await runOutbox(t.tenantId);
    const [mikes] = (await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, a)))).filter((x) => x.sellerUserId === mike);
    expect(mikes!.status).toBe('completed');
    const co = await companyAt(d);
    expect(co.ownerExternalId).toBe(ownerOf(mike));
    const tasks = await tasksOf(co.externalId);
    const ashTasks = tasks.filter((x) => x.ownerExternalId === ownerOf(ash));
    const mikeTasks = tasks.filter((x) => x.ownerExternalId === ownerOf(mike));
    expect(ashTasks).toHaveLength(4);
    expect(ashTasks.every((x) => x.status === 'completed' && x.body!.includes('Withdrawn in Scout'))).toBe(true);
    expect(mikeTasks).toHaveLength(4);
    expect(mikeTasks.every((x) => x.status === 'open')).toBe(true);
    const notes = await notesOf(co.externalId);
    const line = `Withdrawn by ${await nameOf(leader)} on ${await today()}`;
    expect(notes.filter((n) => n.html.includes(line))).toHaveLength(1);
  });
});
