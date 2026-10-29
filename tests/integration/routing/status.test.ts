import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeAccounts } from '@/modules/accounts';
import { rejectArrival, submitArrival } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import { accept, assign, changeStatus, decline, getAccountStatus, listAssignments } from '@/modules/routing';
import { assignment, reviewStatusDef, statusChange } from '@/modules/routing/db/schema';
import { tenant, user } from '@/modules/tenancy/db/schema';
import { adminDb, closeDbs } from '@/platform/db/client';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asSource, personAndAgent } from '../intake/helpers';
import { arrivedAccount, asPerson, domain, member, routingTenant, setSummary, type Tenant } from './helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  await adminDb.update(user).set({ name: 'Ash Eskandari' }).where(eq(user.id, seller));
});
afterAll(closeDbs);

const asSeller = <T,>(fn: Parameters<typeof asPerson<T>>[1], userId = seller) => asPerson(t, fn, { userId, dataLimit: { kind: 'own_accounts' } });
const setAssignedAt = (id: string, at: string) => t.run((ctx) => ctx.tx.update(assignment).set({ assignedAt: new Date(at) }).where(eq(assignment.id, id)));
/** An arrival sent by an agent, resolved into an account. */
async function sentBy(agentId: string) {
  const sent = await asSource(t, agentId, (ctx) => submitArrival(ctx, { account: { name: 'Sent Co', domain: domain() } }, { channel: 'api' }));
  await runOutbox(t.tenantId);
  const [row] = await t.run((ctx) => ctx.tx.select().from(arrival).where(eq(arrival.id, sent.arrivalId)));
  return { arrivalId: sent.arrivalId, accountId: row!.accountId! };
}

describe('account status (REV-E4-S2)', () => {
  it('has the agreed shape and the assigned summary (AC1)', async () => {
    const a = await arrivedAccount(t, { name: 'Shape Co' });
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await setAssignedAt(made.id, '2026-10-22T15:00:00Z');
    await setSummary(t, a, { tier: 'act_now' });
    const s = await asPerson(t, (ctx) => getAccountStatus(ctx, a));
    expect(s).toEqual({
      accountId: a,
      name: 'Shape Co',
      stage: 'reviewed',
      reviewStatus: 'reviewed',
      tier: 'act_now',
      ownerName: 'Ash Eskandari',
      lastActivityAt: null,
      declinedReason: null,
      declinedNote: null,
      sendBackNote: null,
      summary: 'Assigned to Ash on Oct 22.',
    });
  });

  it('an agent asks by the arrival id it was given, limited to its own arrivals (AC2)', async () => {
    const mine = await personAndAgent(t, 'Mine');
    const other = await personAndAgent(t, 'Other');
    const sent = await sentBy(mine.agentId);
    expect(await asSource(t, mine.agentId, (ctx) => getAccountStatus(ctx, sent.arrivalId))).toMatchObject({ accountId: sent.accountId, name: 'Sent Co', stage: 'arrived', reviewStatus: 'unvetted' });
    expect(await asSource(t, mine.agentId, (ctx) => getAccountStatus(ctx, sent.accountId))).toMatchObject({ accountId: sent.accountId });
    expect(await asSource(t, other.agentId, (ctx) => getAccountStatus(ctx, sent.arrivalId))).toBeNull();
    expect(await asSource(t, mine.agentId, (ctx) => getAccountStatus(ctx, newId('evt').replace('evt_', 'arr_')))).toBeNull();
  });

  it('an account outside the data limit is null, never forbidden (AC3)', async () => {
    const mine = await personAndAgent(t, 'Scope');
    const other = await personAndAgent(t, 'Elsewhere');
    const theirs = await sentBy(other.agentId);
    expect(await asSource(t, mine.agentId, (ctx) => getAccountStatus(ctx, theirs.accountId))).toBeNull();
    expect(await asSource(t, mine.agentId, (ctx) => getAccountStatus(ctx, 'acc_nope'))).toBeNull();
  });

  it('a declined account gives the reason, a sent back one gives the note (AC4)', async () => {
    const a = await arrivedAccount(t, { name: 'Declined Co' });
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'duplicate' }));
    expect(await asPerson(t, (ctx) => getAccountStatus(ctx, a))).toMatchObject({
      stage: 'declined',
      reviewStatus: 'declined',
      declinedReason: 'Duplicate',
      declinedNote: null,
      sendBackNote: null,
      summary: 'Declined: Duplicate.',
    });

    await t.run((ctx) =>
      ctx.tx.insert(reviewStatusDef).values({ id: newId('rsd'), tenantId: ctx.tenantId, key: 'needs_info', label: 'Needs more info', order: 5, returnsToSource: true }).onConflictDoNothing(),
    );
    const b = await arrivedAccount(t, { name: 'Back Co' });
    await asPerson(t, (ctx) => changeStatus(ctx, b, { to: 'needs_info', note: 'Send the website' }));
    expect(await asPerson(t, (ctx) => getAccountStatus(ctx, b))).toMatchObject({
      reviewStatus: 'needs_info',
      declinedReason: null,
      sendBackNote: 'Send the website',
      summary: 'Sent back to the source.',
    });
  });
});

describe('account status edges (REV-E4-S2)', () => {
  it('a decline with Other carries its note', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'other', note: 'Out of business' }));
    expect(await asPerson(t, (ctx) => getAccountStatus(ctx, a))).toMatchObject({ declinedReason: 'Other', declinedNote: 'Out of business', summary: 'Declined: Other.' });
  });

  it('falls back to Declined. when the move kept no reason', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => changeStatus(ctx, a, { to: 'declined', reasonKey: 'duplicate' }));
    await t.run((ctx) => ctx.tx.update(statusChange).set({ reasonKey: null }).where(eq(statusChange.accountId, a)));
    expect(await asPerson(t, (ctx) => getAccountStatus(ctx, a))).toMatchObject({ declinedReason: null, declinedNote: null, summary: 'Declined.' });
  });

  it("a person limited to their own accounts gets null on someone else's account", async () => {
    const a = await arrivedAccount(t);
    const stranger = await member(t, 'seller');
    expect(await asSeller((ctx) => getAccountStatus(ctx, a), stranger)).toBeNull();
  });

  it('a seller decline stays hidden from the source', async () => {
    const { agentId } = await personAndAgent(t, 'Hidden');
    const sent = await sentBy(agentId);
    const made = await asPerson(t, (ctx) => assign(ctx, sent.accountId, { sellerUserId: seller }));
    await asSeller((ctx) => decline(ctx, made.id, { reasonKey: 'not_a_fit' }));
    expect(await asSource(t, agentId, (ctx) => getAccountStatus(ctx, sent.arrivalId))).toMatchObject({
      reviewStatus: 'reviewed',
      ownerName: null,
      declinedReason: null,
      declinedNote: null,
      summary: 'Reviewed. Waiting for a seller.',
    });
  });

  it('formats the assigned date in the tenant timezone', async () => {
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    await setAssignedAt(made.id, '2026-10-23T02:00:00Z'); // still Oct 22 in New York
    await adminDb.update(tenant).set({ timezone: 'America/New_York' }).where(eq(tenant.id, t.tenantId));
    try {
      expect((await asPerson(t, (ctx) => getAccountStatus(ctx, a)))?.summary).toBe('Assigned to Ash on Oct 22.');
    } finally {
      await adminDb.update(tenant).set({ timezone: 'UTC' }).where(eq(tenant.id, t.tenantId));
    }
    expect((await asPerson(t, (ctx) => getAccountStatus(ctx, a)))?.summary).toBe('Assigned to Ash on Oct 23.');
  });

  it('an arrival of the caller with no account yet is received; another source gets null', async () => {
    const mine = await personAndAgent(t, 'Early');
    const other = await personAndAgent(t, 'Late');
    const sent = await asSource(t, mine.agentId, (ctx) => submitArrival(ctx, { account: { name: 'Early Co', domain: domain() } }, { channel: 'api' }));
    const expected = { accountId: null, name: null, stage: 'arrived', reviewStatus: null, summary: 'Received. Matching it to an account.' };
    expect(await asSource(t, mine.agentId, (ctx) => getAccountStatus(ctx, sent.arrivalId))).toMatchObject(expected);
    expect(await asSource(t, other.agentId, (ctx) => getAccountStatus(ctx, sent.arrivalId))).toBeNull();
  });

  it('a rejected arrival with no account names the reason, else a plain fallback', async () => {
    const { agentId } = await personAndAgent(t, 'Rejected');
    const send = () => asSource(t, agentId, (ctx) => submitArrival(ctx, { account: { name: 'Nope Co', domain: domain() } }, { channel: 'api' }));
    const one = await send();
    const two = await send();
    await t.run((ctx) => rejectArrival(ctx, one.arrivalId, 'invalid', 'secret detail'));
    await t.run((ctx) => rejectArrival(ctx, two.arrivalId, 'excluded', 'Software vendor'));
    expect((await asSource(t, agentId, (ctx) => getAccountStatus(ctx, one.arrivalId)))?.summary).toBe('Not accepted: the details were not valid.');
    expect((await asSource(t, agentId, (ctx) => getAccountStatus(ctx, two.arrivalId)))?.summary).toBe('Not accepted.');
  });
});

describe('assignment lists (REV-E2-S2)', () => {
  it('a merged account id follows the survivor', async () => {
    const survivor = await arrivedAccount(t);
    const merged = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, merged, { sellerUserId: seller }));
    await asPerson(t, (ctx) => mergeAccounts(ctx, survivor, merged));
    await runOutbox(t.tenantId);
    const page = await asPerson(t, (ctx) => listAssignments(ctx, { accountId: merged }));
    expect(page.data.map((r) => [r.id, r.accountId])).toEqual([[made.id, survivor]]);
  });

  it("mine with an account id lists the seller's own rows for it", async () => {
    const mineOnly = await member(t, 'seller');
    const a = await arrivedAccount(t);
    const made = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: mineOnly }));
    const page = await asSeller((ctx) => listAssignments(ctx, { mine: true, accountId: a }), mineOnly);
    expect(page.data.map((r) => r.id)).toEqual([made.id]);
    await expect(asPerson(t, (ctx) => listAssignments(ctx, { accountId: 'acc_nope' }))).rejects.toMatchObject({ status: 404 });
  });

  it("a past owner sees the newer seller's assignment on the account they can still see", async () => {
    const first = await member(t, 'seller');
    const second = await member(t, 'seller');
    const a = await arrivedAccount(t);
    const one = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: first }));
    await asSeller((ctx) => accept(ctx, one.id), first);
    await runOutbox(t.tenantId);
    const two = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: second }));
    await runOutbox(t.tenantId);
    const page = await asSeller((ctx) => listAssignments(ctx, { accountId: a }), first);
    expect(page.data.map((r) => r.id).sort()).toEqual([one.id, two.id].sort());
  });

  it('a restricted seller with many hidden assignments gets a short page and a cursor that reaches their rows', async () => {
    const t2 = await routingTenant();
    const me = await member(t2, 'seller');
    const limited = { userId: me, dataLimit: { kind: 'own_accounts' } } as const;
    const a = await arrivedAccount(t2);
    const mine = await asPerson(t2, (ctx) => assign(ctx, a, { sellerUserId: me }));
    await asPerson(t2, (ctx) => accept(ctx, mine.id), limited);
    await runOutbox(t2.tenantId);
    const other = await member(t2, 'seller');
    await t2.run((ctx) =>
      ctx.tx.insert(assignment).values(
        Array.from({ length: 520 }, (_, i) => ({
          id: newId('asg'),
          tenantId: ctx.tenantId,
          accountId: `hidden-${i}`,
          sellerUserId: other,
          assignedBy: other,
          assignedAt: new Date('2027-01-01T00:00:00Z'),
          status: 'declined',
        })),
      ),
    );
    const run = (cursor?: string) => asPerson(t2, (ctx) => listAssignments(ctx, { limit: 5, cursor }), limited);
    const first = await run();
    expect(first.data).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    let found: string[] = [];
    let cursor: string | null = first.nextCursor;
    for (let i = 0; i < 5 && cursor && found.length === 0; i++) {
      const page = await run(cursor);
      found = page.data.map((r) => r.id);
      cursor = page.nextCursor;
    }
    expect(found).toEqual([mine.id]);
  });

  it('a seller lists their pending assignments, and only theirs (AC1)', async () => {
    const other = await member(t, 'seller');
    const mineOnly = await member(t, 'seller');
    const a = await arrivedAccount(t);
    const b = await arrivedAccount(t);
    const c = await arrivedAccount(t);
    const first = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: mineOnly }));
    const second = await asPerson(t, (ctx) => assign(ctx, b, { sellerUserId: mineOnly }));
    await asPerson(t, (ctx) => assign(ctx, c, { sellerUserId: other }));
    await asSeller((ctx) => accept(ctx, second.id), mineOnly);
    const pending = await asSeller((ctx) => listAssignments(ctx, { mine: true, status: 'pending' }), mineOnly);
    expect(pending.data.map((r) => r.id)).toEqual([first.id]);
    expect(pending.data[0]).toMatchObject({ accountId: a, sellerUserId: mineOnly, status: 'pending', acceptedHow: null });
    const all = await asSeller((ctx) => listAssignments(ctx, { mine: true }), mineOnly);
    expect(all.data.map((r) => r.id)).toEqual(expect.arrayContaining([first.id, second.id]));
    expect(all.data.every((r) => r.sellerUserId === mineOnly)).toBe(true);
  });

  it('the leader sees how each was accepted (AC3)', async () => {
    const a = await arrivedAccount(t);
    const b = await arrivedAccount(t);
    const bySeller = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    const waiting = await asPerson(t, (ctx) => assign(ctx, b, { sellerUserId: seller }));
    await asSeller((ctx) => accept(ctx, bySeller.id));
    await t.run((ctx) => ctx.tx.update(assignment).set({ status: 'accepted', acceptedHow: 'auto_timeout', respondedAt: new Date() }).where(eq(assignment.id, waiting.id)));
    const rowsFor = async (accountId: string) => (await asPerson(t, (ctx) => listAssignments(ctx, { accountId }))).data;
    expect(await rowsFor(a)).toEqual([expect.objectContaining({ id: bySeller.id, acceptedHow: 'seller', accountName: 'Queue Co' })]);
    expect(await rowsFor(b)).toEqual([expect.objectContaining({ id: waiting.id, acceptedHow: 'auto_timeout' })]);
  });

  it('with an account id, the account must be visible', async () => {
    const a = await arrivedAccount(t);
    await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: seller }));
    const stranger = await member(t, 'seller');
    await expect(asPerson(t, (ctx) => listAssignments(ctx, { accountId: a }), { userId: stranger, dataLimit: { kind: 'own_accounts' } })).rejects.toMatchObject({ status: 404 });
  });

  it('pages newest first with a cursor', async () => {
    const lister = await member(t, 'seller');
    const made: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await arrivedAccount(t);
      const m = await asPerson(t, (ctx) => assign(ctx, a, { sellerUserId: lister }));
      await setAssignedAt(m.id, `2026-10-2${i}T10:00:00Z`);
      made.push(m.id);
    }
    const run = (cursor?: string) => asPerson(t, (ctx) => listAssignments(ctx, { mine: true, limit: 2, cursor }), { userId: lister });
    const p1 = await run();
    expect(p1.data.map((r) => r.id)).toEqual([made[2], made[1]]);
    const p2 = await run(p1.nextCursor!);
    expect(p2.data.map((r) => r.id)).toEqual([made[0]]);
    expect(p2.nextCursor).toBeNull();
    await expect(run('garbage')).rejects.toMatchObject({ status: 400 });
  });
});
