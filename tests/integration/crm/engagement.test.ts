import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import '@/entry/compose';
import { upsertFromArrival } from '@/modules/accounts';
import { activityObserved, getHandoffs, seedMockCrm, syncAccount, syncOwners } from '@/modules/crm';
import { activity, handoff } from '@/modules/crm/db/schema';
import { mockAddActivity, mockSetActivity } from '@/modules/crm/fixtures';
import { assign } from '@/modules/routing';
import { adminDb, closeDbs } from '@/platform/db/client';
import { outbox } from '@/platform/db/schema';
import { newId } from '@/platform/ids';
import { runOutbox } from '../helpers/run-outbox';
import { asPerson, domain, member, resolved, routingTenant, type Tenant } from '../routing/helpers';

let t: Tenant;
let seller: string;

beforeAll(async () => {
  t = await routingTenant();
  seller = await member(t, 'seller');
  await t.run((ctx) => seedMockCrm(ctx));
  await t.run((ctx) => syncOwners(ctx));
});
afterAll(closeDbs);

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** An account assigned to the seller and pushed to the mock. */
async function handedOff(): Promise<string> {
  const arrivalId = newId('evt').replace('evt_', 'arr_');
  const { accountId } = await t.run((ctx) =>
    upsertFromArrival(ctx, {
      arrivalId,
      receivedAt: new Date(),
      sourceChain: {},
      account: { name: 'Meeting Co', domain: domain() },
      people: [{ firstName: 'Ana', lastName: 'Meet', title: 'CTO', email: `ana.${newId('acc').slice(-6).toLowerCase()}@meet.example` }],
      signals: [],
      facts: [],
      research: {},
      soleProprietor: false,
      externalIds: [],
    }),
  );
  await resolved(t, accountId, { arrivalId, resolution: 'created' });
  await asPerson(t, (ctx) => assign(ctx, accountId, { sellerUserId: seller }));
  await runOutbox(t.tenantId);
  return accountId;
}

const handoffOf = async (a: string) => (await t.run((ctx) => ctx.tx.select().from(handoff).where(eq(handoff.accountId, a))))[0]!;
const rows = (a: string) => t.run((ctx) => ctx.tx.select().from(activity).where(eq(activity.accountId, a)));
const observed = async (a: string) =>
  (await adminDb.select().from(outbox).where(eq(outbox.tenantId, t.tenantId)).orderBy(outbox.seq))
    .map((r) => r.payload as { type: string; data: Record<string, unknown> })
    .filter((e) => e.type === activityObserved.type && e.data.accountId === a)
    .map((e) => e.data);
const sync = (a: string, now = new Date()) => t.run((ctx) => syncAccount(ctx, a, now));
const followThroughOf = async (a: string, now?: Date) => (await t.run((ctx) => getHandoffs(ctx, a, now))).followThrough!;
const meeting = (companyExternalId: string, startAt: Date, over: { subject?: string; status?: 'scheduled' | 'held' } = {}) =>
  t.run((ctx) =>
    mockAddActivity(ctx, {
      companyExternalId,
      kind: 'meeting',
      occurredAt: startAt,
      startAt,
      endAt: new Date(startAt.getTime() + HOUR / 2),
      status: over.status ?? 'scheduled',
      subject: over.subject ?? null,
    }),
  );

describe('meetings held and the next meeting (R2d Rulings 1, 2, 5)', () => {
  it('a held meeting counts and the next meeting shows', async () => {
    const a = await handedOff();
    const co = (await handoffOf(a)).companyExternalId!;
    await meeting(co, new Date(), { status: 'held', subject: 'Intro' });
    const next = new Date(Date.now() + 5 * DAY);
    await meeting(co, next, { subject: 'Scoping call' });
    await meeting(co, new Date(Date.now() + 9 * DAY), { subject: 'Later call' });
    await sync(a);
    const ft = await followThroughOf(a);
    expect(ft.meetingsHeld).toBe(1);
    expect(ft.nextMeeting).toEqual({ at: next.toISOString(), with: 'Scoping call' });
    const stored = (await rows(a)).find((r) => r.subject === 'Scoping call')!;
    expect(stored).toMatchObject({ kind: 'meeting', status: 'scheduled', startAt: next, contacts: [] });
  });

  it('a future meeting does not hide later emails', async () => {
    const a = await handedOff();
    const co = (await handoffOf(a)).companyExternalId!;
    await meeting(co, new Date(Date.now() + 5 * DAY), { subject: 'Scoping call' });
    await sync(a);
    const email = await t.run((ctx) => mockAddActivity(ctx, { companyExternalId: co, kind: 'email', subject: 'The outline' }));
    await sync(a);
    expect((await rows(a)).find((r) => r.externalId === email)).toMatchObject({ kind: 'email', subject: 'The outline' });
  });

  it('a booked meeting whose start passes with no sync in between does not hide the emails before it', async () => {
    const a = await handedOff();
    const done = (await handoffOf(a)).completedAt!;
    const co = (await handoffOf(a)).companyExternalId!;
    await meeting(co, new Date(done.getTime() + 5 * HOUR), { subject: 'Scoping call' });
    await sync(a, new Date(done.getTime() + HOUR));
    const email = await t.run((ctx) => mockAddActivity(ctx, { companyExternalId: co, kind: 'email', occurredAt: new Date(done.getTime() + 3 * HOUR) }));
    await sync(a, new Date(done.getTime() + 6 * HOUR));
    expect((await rows(a)).find((r) => r.externalId === email)).toMatchObject({ kind: 'email' });
  });

  it('a cancelled meeting updates in place', async () => {
    const a = await handedOff();
    const co = (await handoffOf(a)).companyExternalId!;
    const ext = await meeting(co, new Date(Date.now() + 5 * DAY), { subject: 'Scoping call' });
    await sync(a);
    const moved = new Date(Date.now() + 7 * DAY);
    await t.run((ctx) => mockSetActivity(ctx, ext, { startAt: moved, endAt: new Date(moved.getTime() + HOUR) }));
    await sync(a);
    expect((await followThroughOf(a)).nextMeeting).toEqual({ at: moved.toISOString(), with: 'Scoping call' });
    await t.run((ctx) => mockSetActivity(ctx, ext, { status: 'cancelled' }));
    await sync(a);
    expect((await followThroughOf(a)).nextMeeting).toBeNull();
    const mine = (await rows(a)).filter((r) => r.externalId === ext);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'cancelled', startAt: moved });
    expect((await observed(a)).filter((e) => e.externalId === ext)).toHaveLength(1);
    // Read again unchanged: the row is not written (its row version stays).
    const version = () => t.run(async (ctx) => (await ctx.tx.select({ v: sql<string>`xmin::text` }).from(activity).where(eq(activity.externalId, ext)))[0]!.v);
    const before = await version();
    await sync(a);
    expect(await version()).toBe(before);
  });

  it('a meeting already past the poll updates too: meetings from 30 days back are read again', async () => {
    const a = await handedOff();
    const done = (await handoffOf(a)).completedAt!;
    const co = (await handoffOf(a)).companyExternalId!;
    const ext = await meeting(co, new Date(done.getTime() + HOUR), { subject: 'Scoping call' });
    await t.run((ctx) => mockAddActivity(ctx, { companyExternalId: co, kind: 'email', occurredAt: new Date(done.getTime() + 2 * HOUR) }));
    await sync(a, new Date(done.getTime() + 3 * HOUR));
    expect((await followThroughOf(a, new Date(done.getTime() + 3 * HOUR))).meetingsHeld).toBe(1);
    await t.run((ctx) => mockSetActivity(ctx, ext, { status: 'no_show' }));
    await sync(a, new Date(done.getTime() + 4 * HOUR));
    expect((await rows(a)).find((r) => r.externalId === ext)).toMatchObject({ status: 'no_show' });
    expect((await followThroughOf(a, new Date(done.getTime() + 4 * HOUR))).meetingsHeld).toBe(0);
    expect((await observed(a)).filter((e) => e.externalId === ext)).toHaveLength(1);
  });

  it('a meeting from before the handoff is not new, even when read again for its date', async () => {
    const a = await handedOff();
    const done = (await handoffOf(a)).completedAt!;
    const co = (await handoffOf(a)).companyExternalId!;
    const ext = await meeting(co, new Date(done.getTime() - 2 * DAY), { status: 'held' });
    await sync(a);
    expect((await rows(a)).filter((r) => r.externalId === ext)).toHaveLength(0);
    expect((await observed(a)).filter((e) => e.externalId === ext)).toHaveLength(0);
  });
});
