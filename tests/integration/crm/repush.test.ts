import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { getAccount, upsertFromArrival, type ArrivalForAccounts } from '@/modules/accounts';
import { getLinks, hubspotMock, push, seedMockCrm, setCrmSettings, syncOwners } from '@/modules/crm';
import { crmSetting, handoff, mockCompany, mockNote, mockPerson, mockTask } from '@/modules/crm/db/schema';
import { mockCompleteTask, mockEditNote, setMockFailure } from '@/modules/crm/fixtures';
import { assign, decline, withdraw } from '@/modules/routing';
import { addMember } from '@/modules/tenancy';
import { closeDbs } from '@/platform/db/client';
import { ScoutError } from '@/platform/errors';
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

const arrival = (d: string, people: ArrivalPerson[]): ArrivalForAccounts => ({
  arrivalId: newId('evt').replace('evt_', 'arr_'),
  receivedAt: new Date(),
  sourceChain: {},
  account: { name: 'Repush Co', domain: d },
  people,
  signals: [],
  facts: [],
  research: {},
  soleProprietor: false,
  externalIds: [],
});

async function account(opts: { domain?: string; people?: ArrivalPerson[] } = {}): Promise<string> {
  const a = arrival(opts.domain ?? domain(), opts.people ?? []);
  const { accountId } = await t.run((ctx) => upsertFromArrival(ctx, a));
  await resolved(t, accountId, { arrivalId: a.arrivalId, resolution: 'created' });
  return accountId;
}

const person = (i: number): ArrivalPerson => ({
  firstName: `Kim${i}`,
  lastName: 'Repush',
  title: 'CTO',
  email: `kim${i}.${newId('acc').slice(-6).toLowerCase()}@repush.example`,
});

const handoffsOf = (accountId: string) =>
  t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, accountId)).orderBy(handoff.queuedAt, handoff.id));
const companyAt = async (d: string) => (await t.run((ctx) => ctx.tx.select().from(mockCompany).where(eq(mockCompany.domain, d))))[0]!;
const notesOf = (companyId: string) => t.run((ctx) => ctx.tx.select().from(mockNote).where(eq(mockNote.companyExternalId, companyId)).orderBy(mockNote.externalId));
const tasksOf = (companyId: string) => t.run((ctx) => ctx.tx.select().from(mockTask).where(eq(mockTask.companyExternalId, companyId)));
const domainOf = async (accountId: string) => (await t.run((ctx) => getAccount(ctx, accountId)))!.domain!;
const asLeader = <T>(fn: Parameters<typeof asPerson<T>>[1]) => asPerson(t, fn, { userId: leader });

async function pushed(opts: { domain?: string; people?: ArrivalPerson[]; seller?: string } = {}) {
  const a = await account(opts);
  const made = await asLeader((ctx) => assign(ctx, a, { sellerUserId: opts.seller ?? ash }));
  await runOutbox(t.tenantId);
  const [h] = await handoffsOf(a);
  expect(h!.status).toBe('completed');
  return { a, asg: made.id, h: h!, d: await domainOf(a) };
}

const conflictOf = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ScoutError);
  return e as ScoutError;
};

describe('re-push (CRM-E3-S6, Ruling 20)', () => {
  it('after a rep edited the note and completed the first touch: a new note, the first touch left done, follow-ups updated in place (Review Focus 3)', async () => {
    const { a, asg, h, d } = await pushed({ people: [person(1)] });
    const co = await companyAt(d);
    const links = await t.run((ctx) => getLinks(ctx, a));
    const firstTouch = links.tasks.find((l) => l.scoutId === `${asg}:first_touch`)!.externalId;
    await t.run((ctx) => mockEditNote(ctx, links.note!.externalId));
    await t.run((ctx) => mockCompleteTask(ctx, firstTouch));
    // Mark every task, so an update in place shows.
    await t.run((ctx) => ctx.tx.update(mockTask).set({ subject: 'stale' }).where(eq(mockTask.companyExternalId, co.externalId)));

    const { handoffId } = await asLeader((ctx) => push(ctx, a));
    await runOutbox(t.tenantId);

    const all = await handoffsOf(a);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ id: handoffId, assignmentId: asg, sellerUserId: ash, status: 'completed', isRepush: true, ownershipAction: 'assign' });
    expect(all[1]!.handoffBatchId).not.toBe(h.handoffBatchId);

    const notes = await notesOf(co.externalId);
    expect(notes).toHaveLength(2);
    expect(notes[0]!.html).toContain('Edited by a rep.');
    expect(notes[1]!.html).not.toContain('Edited by a rep.');

    const tasks = await tasksOf(co.externalId);
    expect(tasks).toHaveLength(4);
    const ft = tasks.find((x) => x.externalId === firstTouch)!;
    expect(ft).toMatchObject({ status: 'completed', subject: 'stale' });
    const followUps = tasks.filter((x) => x.externalId !== firstTouch);
    expect(followUps.every((x) => x.status === 'open' && x.subject.startsWith('Follow-up'))).toBe(true);
  });

  it('a note nobody edited is updated in place', async () => {
    const { a, d } = await pushed();
    await asLeader((ctx) => push(ctx, a));
    await runOutbox(t.tenantId);
    expect(await notesOf((await companyAt(d)).externalId)).toHaveLength(1);
  });

  it('keepCurrentOwner records keep (CRM-E3-S6-AC2)', async () => {
    const { a } = await pushed();
    const { handoffId } = await asLeader((ctx) => push(ctx, a, { keepCurrentOwner: true }));
    await runOutbox(t.tenantId);
    const [, again] = await handoffsOf(a);
    expect(again).toMatchObject({ id: handoffId, ownershipAction: 'keep', status: 'completed' });
  });

  it("refuses with 409 'Assign it before pushing.' after a decline, and with no handoff", async () => {
    const { a, asg } = await pushed();
    await asPerson(t, (ctx) => decline(ctx, asg, { reasonKey: 'not_my_territory' }), { userId: ash });
    await runOutbox(t.tenantId);
    const e = await conflictOf(asLeader((ctx) => push(ctx, a)));
    expect(e).toMatchObject({ status: 409, message: 'Assign it before pushing.' });

    const fresh = await account();
    expect(await conflictOf(asLeader((ctx) => push(ctx, fresh)))).toMatchObject({ status: 409, message: 'Assign it before pushing.' });
  });

  it('not found outside the data limit', async () => {
    const { a } = await pushed();
    const e = await conflictOf(asPerson(t, (ctx) => push(ctx, a), { userId: leader, dataLimit: { kind: 'sources', ids: [] } }));
    expect(e.status).toBe(404);
  });

  it('the same call retries a failed handoff, which completes', async () => {
    const a = await account();
    await t.run((ctx) => setMockFailure(ctx, 'upsertCompany', '401', 1));
    await asLeader((ctx) => assign(ctx, a, { sellerUserId: ash }));
    await runOutbox(t.tenantId);
    expect((await handoffsOf(a))[0]!.status).toBe('failed');
    await asLeader((ctx) => push(ctx, a));
    await runOutbox(t.tenantId);
    const [first, retry] = await handoffsOf(a);
    expect(first!.status).toBe('failed');
    expect(retry).toMatchObject({ status: 'completed', attempts: 1 });
  });

  it('a re-push then a decline: the assignment\'s tasks are closed once, one undo note, both handoffs undone', async () => {
    const { a, asg, d } = await pushed({ domain: 'owned-elsewhere.example' });
    expect((await handoffsOf(a))[0]!.takenFromOwner).toBe(vijay);
    await asLeader((ctx) => push(ctx, a));
    await runOutbox(t.tenantId);
    const co = await companyAt(d);
    expect(co.ownerExternalId).toBe(ownerOf(ash));

    await asPerson(t, (ctx) => decline(ctx, asg, { reasonKey: 'not_my_territory' }), { userId: ash });
    await runOutbox(t.tenantId);

    const tasks = (await tasksOf(co.externalId)).filter((x) => x.ownerExternalId === ownerOf(ash));
    expect(tasks).toHaveLength(4);
    for (const x of tasks) {
      expect(x.status).toBe('completed');
      expect(x.body!.split('Declined in Scout').length - 1).toBe(1);
    }
    const undoNotes = (await notesOf(co.externalId)).filter((n) => n.html.includes('Returned by'));
    expect(undoNotes).toHaveLength(1);
    expect((await companyAt(d)).ownerExternalId).toBe(vijay);
    const all = await handoffsOf(a);
    expect(all).toHaveLength(2);
    for (const h of all) {
      expect(h.undone).toMatchObject({ ownerReturnedTo: vijay, noteExternalId: undoNotes[0]!.externalId });
      expect([...h.undone!.tasksClosed].sort()).toEqual(tasks.map((x) => x.externalId).sort());
    }
  });

  it('a later handoff takes from the current owner when an earlier undo already returned ownership', async () => {
    const d = domain();
    await t.run((ctx) => hubspotMock(ctx).upsertCompany({ domain: d, name: d, ownerExternalId: vijay, replaceableOwner: true, properties: {} }));
    const { a, asg } = await pushed({ domain: d });
    await asLeader((ctx) => withdraw(ctx, asg, {}));
    await runOutbox(t.tenantId);
    expect((await handoffsOf(a))[0]!.undone).toMatchObject({ ownerReturnedTo: vijay });
    // Mike has it and gives it back, so the last push Scout made is no longer Ash's.
    const second = await asLeader((ctx) => assign(ctx, a, { sellerUserId: mike }));
    await runOutbox(t.tenantId);
    await asLeader((ctx) => withdraw(ctx, second.id, {}));
    await runOutbox(t.tenantId);
    expect((await companyAt(d)).ownerExternalId).toBe(vijay);
    // Someone gives it to Ash by hand in HubSpot afterwards.
    await t.run((ctx) => ctx.tx.update(mockCompany).set({ ownerExternalId: ownerOf(ash) }).where(eq(mockCompany.domain, d)));

    const third = await asLeader((ctx) => assign(ctx, a, { sellerUserId: mike }));
    await runOutbox(t.tenantId);
    const h = (await handoffsOf(a)).find((x) => x.assignmentId === third.id)!;
    // Ash's own undo already gave it back to Vijay, so it was taken from Ash, not Vijay.
    expect(h).toMatchObject({ status: 'completed', takenFromOwner: ownerOf(ash) });
  });
});

describe('push new people (Ruling 22)', () => {
  const addPerson = async (accountId: string, p: ArrivalPerson) => {
    const d = await domainOf(accountId);
    await t.run((ctx) => upsertFromArrival(ctx, arrival(d, [p]), accountId));
    await runOutbox(t.tenantId);
  };
  const personLinks = (accountId: string) => t.run(async (ctx) => (await getLinks(ctx, accountId)).people);

  it('a person added to a handed-off account is pushed with the handoff owner and linked', async () => {
    const { a, d } = await pushed({ people: [person(2)] });
    const p = person(3);
    await addPerson(a, p);
    const links = await personLinks(a);
    expect(links).toHaveLength(2);
    const co = await companyAt(d);
    const people = await t.run((ctx) => ctx.tx.select().from(mockPerson).where(eq(mockPerson.companyExternalId, co.externalId)));
    const added = people.find((x) => x.email === p.email)!;
    expect(added.ownerExternalId).toBe(ownerOf(ash));
    expect(links.map((l) => l.externalId)).toContain(added.externalId);
  });

  it('with the setting off nothing is pushed', async () => {
    const { a } = await pushed({ people: [person(4)] });
    await t.run((ctx) => setCrmSettings(ctx, { pushNewPeople: false }));
    try {
      await addPerson(a, person(5));
      expect(await personLinks(a)).toHaveLength(1);
    } finally {
      await t.run((ctx) => ctx.tx.update(crmSetting).set({ pushNewPeople: true }).where(eq(crmSetting.tenantId, ctx.tenantId)));
    }
  });

  it('an account with 10 people linked gets no more', async () => {
    const { a } = await pushed({ people: Array.from({ length: 10 }, (_, i) => person(10 + i)) });
    await addPerson(a, person(30));
    expect(await personLinks(a)).toHaveLength(10);
  });
});
