import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { submitArrival } from '@/modules/intake';
import { arrival } from '@/modules/intake/db/schema';
import { accept, assign, changeStatus, getAccountStatus, listAssignments } from '@/modules/routing';
import { assignment, reviewStatusDef } from '@/modules/routing/db/schema';
import { user } from '@/modules/tenancy/db/schema';
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

describe('assignment lists (REV-E2-S2)', () => {
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
